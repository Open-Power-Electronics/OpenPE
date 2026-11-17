import { execFile } from 'node:child_process';
import path from 'node:path';

/** Absolute taskkill. A missing or relative SystemRoot cannot select another executable.
 * @param {{ SystemRoot?: string }} [env]
 */
export function windowsTaskkillCommand(env = process.env) {
  const root = env.SystemRoot;
  if (typeof root !== 'string' || !path.win32.isAbsolute(root))
    throw new Error('SystemRoot is required to stop a Windows process tree.');
  return path.win32.join(root, 'System32', 'taskkill.exe');
}

function childAlive(proc, options) {
  return !options.closed() && proc.exitCode === null && proc.signalCode === null;
}

/**
 * Stop one owned CLI process tree.
 * Windows runs %SystemRoot%\System32\taskkill.exe /t and throws if SystemRoot
 * is missing. When taskkill fails and the child is still alive, the direct
 * child is killed; if that kill fails, the taskkill error is thrown.
 * POSIX requires the child to be spawned detached so it leads a process group;
 * kill(-pid) signals that group. ESRCH means the process already exited.
 * @param {import('node:child_process').ChildProcess} proc
 * @param {{ closed: () => boolean, signal?: NodeJS.Signals, timeoutMs: number, platform?: NodeJS.Platform, env?: { SystemRoot?: string }, execFile?: typeof execFile }} options
 */
export function stopOwnedProcess(proc, options) {
  if (!proc.pid || options.closed()) return;
  const signal = options.signal ?? 'SIGTERM';
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const file = windowsTaskkillCommand(options.env ?? process.env);
    const run = options.execFile ?? execFile;
    run(
      file,
      ['/pid', String(proc.pid), '/t', '/f'],
      { windowsHide: true, timeout: options.timeoutMs },
      (error) => {
        if (!error || !childAlive(proc, options)) return;
        try {
          if (proc.kill(signal) === false) throw error;
        } catch (killError) {
          if (killError === error) throw error;
          if (killError.code !== 'ESRCH') throw killError;
        }
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
