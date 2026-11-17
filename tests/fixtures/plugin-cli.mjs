import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [mode, ...args] = process.argv.slice(2);
assert.equal(args[0], 'plugin');
if (mode === 'hang') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  writeFileSync('plugin-pids.json', JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(20000));
  setInterval(() => {}, 1000);
} else if (mode === 'error') {
  process.stderr.write('Sign in using your CLI.');
  process.exitCode = 1;
} else {
  process.stdin.resume();
  process.stdin.on('end', () => process.stdout.write(JSON.stringify(args)));
}
