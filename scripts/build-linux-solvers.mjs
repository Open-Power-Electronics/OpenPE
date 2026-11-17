import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Linux solver builds run only on glibc Linux x64.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--update-lock'))
  throw new Error('Usage: npm run solvers:build-linux -- [--update-lock]');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}.`));
    });
  });
await run('/bin/bash', ['scripts/build-ngspice-linux.sh']);
await run('/bin/bash', ['scripts/build-thermal-linux.sh']);
await run(process.execPath, [
  args.length ? 'scripts/pin-linux-solvers.mjs' : 'scripts/pack-solver-archives.mjs',
]);
