import { readFile } from 'node:fs/promises';

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

// A Linux container's PID 1 may leave a stopped orphan as a zombie. kill(pid, 0)
// still succeeds for it, although it cannot execute. Do not mistake it for a
// live leaked child, or weaken the check for processes that are still running.
export async function waitForProcessStopped(pid, timeoutMs = 2000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned fixture PID.');
  const deadline = Date.now() + timeoutMs;
  do {
    if (!exists(pid)) return;
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && /^[ZX] /.test(stat.slice(stat.lastIndexOf(')') + 2))) return;
      if (!stat && !exists(pid)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Owned fixture process ${pid} is still running.`);
}
