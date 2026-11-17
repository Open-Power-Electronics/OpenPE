import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveAgent } from './agents.mjs';
import { validPluginId } from './plugin-id.mjs';

// Narrow config RPC: never accept a renderer-supplied key, path or method.
export async function setCodexPluginEnabled(id, enabled, cwd, signal, options = {}) {
  if (!validPluginId(id) || typeof enabled !== 'boolean') throw new Error('Invalid plugin switch.');
  const launch = await (options.resolve || resolveAgent)('codex');
  if (signal.aborted) throw new Error('Plugin operation cancelled.');
  return new Promise((resolve, reject) => {
    const proc = spawn(launch.file, [...launch.args, 'app-server', '--listen', 'stdio://'], {
      cwd,
      env: launch.env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '',
      bytes = 0,
      settled = false,
      closed = false,
      stopTimer;
    const kill = () => {
      if (closed || !proc.pid) return;
      if (process.platform === 'win32')
        execFile(
          'taskkill.exe',
          ['/pid', String(proc.pid), '/t', '/f'],
          { windowsHide: true, timeout: 5000 },
          (error) => {
            if (error) proc.kill('SIGKILL');
          },
        );
      else {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      proc.stdin.end();
      if (!closed) stopTimer = setTimeout(kill, 250);
      if (error) reject(error);
      else resolve({ ok: true });
    };
    const abort = () => {
      kill();
      finish(new Error('Plugin operation cancelled. Refresh to check its state.'));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error('Plugin switch timed out. Refresh to check its state.'));
    }, options.timeoutMs || 15000);
    const send = (value) => {
      if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(value) + '\n');
    };
    let pending = 1;
    const consume = (line) => {
      if (settled || !line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && message.method) {
        send({
          id: message.id,
          error: { code: -32601, message: 'OpenPE does not grant interactive requests.' },
        });
        return finish(
          new Error('Resolve the requested interactive action in Codex before switching plugins.'),
        );
      }
      if (message.id !== pending) return;
      if (message.error)
        return finish(
          new Error(
            `Could not switch plugin: ${String(message.error.message || 'Update Codex and retry.').slice(0, 500)}`,
          ),
        );
      if (pending === 1) {
        send({ method: 'initialized', params: {} });
        pending = 2;
        send({
          id: pending,
          method: 'config/value/write',
          params: {
            keyPath: `plugins.${JSON.stringify(id)}.enabled`,
            value: enabled,
            mergeStrategy: 'upsert',
          },
        });
      } else {
        if (message.result?.status !== 'ok')
          return finish(
            new Error(
              'Plugin state is overridden by provider policy. Refresh to check the effective state.',
            ),
          );
        finish();
      }
    };
    proc.on('spawn', () => {
      if (signal.aborted) return abort();
      send({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'openpe', version: '0.1.0' } },
      });
    });
    const count = (data) => {
      bytes += data.length;
      if (bytes > 4_000_000) {
        kill();
        finish(new Error('Plugin response exceeded the supported size.'));
        return false;
      }
      return !settled;
    };
    proc.stdout.on('data', (data) => {
      if (!count(data)) return;
      buffer += decoder.write(data);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    proc.stderr.on('data', count);
    proc.stdin.on('error', () => finish(new Error('Plugin connection closed.')));
    proc.on('error', () => finish(new Error('Could not start Codex. Detect agents and retry.')));
    proc.on('close', () => {
      closed = true;
      clearTimeout(stopTimer);
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer);
      if (!settled) finish(new Error('Codex closed before confirming the plugin change.'));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
