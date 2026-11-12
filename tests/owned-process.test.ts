import test from 'node:test';
import assert from 'node:assert/strict';
import { stopOwnedProcess, windowsTaskkillCommand } from '../server/owned-process.mjs';

test('Windows stop uses the absolute SystemRoot taskkill and surfaces a failed direct kill', () => {
  assert.equal(
    windowsTaskkillCommand({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\taskkill.exe',
  );
  assert.throws(() => windowsTaskkillCommand({}), /SystemRoot/);
  assert.throws(() => windowsTaskkillCommand({ SystemRoot: 'Windows' }), /SystemRoot/);

  const calls: { file: string; args: readonly string[]; timeout: number }[] = [];
  let kills = 0;
  const proc = {
    pid: 42,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill() {
      kills += 1;
      return true;
    },
  };
  let callback: (error: Error | null, stdout: string, stderr: string) => void = () => {};
  stopOwnedProcess(proc as never, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    closed: () => false,
    timeoutMs: 1000,
    execFile: ((file: string, args: readonly string[], options: { timeout: number }, done: typeof callback) => {
      calls.push({ file, args, timeout: options.timeout });
      callback = done;
      return proc;
    }) as never,
  });
  assert.deepEqual(calls, [
    {
      file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/pid', '42', '/t', '/f'],
      timeout: 1000,
    },
  ]);
  callback(null, '', '');
  assert.equal(kills, 0);

  const failure = Object.assign(new Error('taskkill failed'), { code: 'ENOENT' });
  callback(failure, '', '');
  assert.equal(kills, 1);

  proc.exitCode = 0;
  callback(failure, '', '');
  assert.equal(kills, 1);
  proc.exitCode = null;

  proc.kill = () => {
    const error = Object.assign(new Error('gone'), { code: 'ESRCH' });
    throw error;
  };
  callback(failure, '', '');

  proc.kill = () => false;
  assert.throws(() => callback(failure, '', ''), (error: unknown) => {
    assert.equal(error, failure);
    return true;
  });

  let launched = false;
  assert.throws(
    () =>
      stopOwnedProcess(proc as never, {
        platform: 'win32',
        env: {},
        closed: () => false,
        timeoutMs: 1000,
        execFile: (() => {
          launched = true;
        }) as never,
      }),
    /SystemRoot/,
  );
  assert.equal(launched, false);
});
