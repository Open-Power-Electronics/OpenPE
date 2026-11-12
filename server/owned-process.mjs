import { execFile } from 'node:child_process';

/**
 * Stop one owned CLI process tree.
 * Windows uses a single taskkill /t, then the captured child if that helper fails.
 * POSIX requires the child to be spawned detached so it leads a process group;
 * kill(-pid) signals that group. ESRCH means the process already exited.
 * @param {import('node:child_process').ChildProcess} proc
 * @param {{ closed: () => boolean, signal?: NodeJS.Signals, timeoutMs: number }} options
 */
export function stopOwnedProcess(proc, options) {
  if (!proc.pid || options.closed()) return;
  const signal = options.signal ?? 'SIGTERM';
  if (process.platform === 'win32') {
    execFile(
      'taskkill.exe',
      ['/pid', String(proc.pid), '/t', '/f'],
      { windowsHide: true, timeout: options.timeoutMs },
      () => {
        if (!options.closed()) proc.kill(signal);
      },
    );
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    if (options.closed()) return;
    try {
      proc.kill(signal);
    } catch (killError) {
      if (killError.code !== 'ESRCH') throw killError;
    }
  }
}
