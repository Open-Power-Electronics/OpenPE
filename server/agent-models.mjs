import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveAgent } from './agents.mjs';
import { validModelId } from './model-id.mjs';
import { isAgentProvider } from './agent-provider-format.mjs';
import { agentIntegrationError, verifyPiIsolation } from './agent-provider-runtime.mjs';
import { listPiModels } from './agent-pi.mjs';

// Model discovery starts no inference and never reads credential files. ACP
// catalogs use an empty session that is closed without submitting a prompt.
export async function listAgentModels(provider, cwd, signal, options = {}) {
  if (!isAgentProvider(provider)) throw new Error('Unknown agent.');
  if (provider === 'deepseek' || provider === 'cursor') {
    const integrationError = agentIntegrationError(provider);
    if (integrationError) throw new Error(integrationError);
    const launch = await (options.resolve || resolveAgent)(provider);
    if (signal.aborted) throw new Error('Model loading cancelled.');
    const { listACPModels } = await import('./agent-acp.mjs');
    return listACPModels(provider, signal, { launch, timeoutMs: options.timeoutMs });
  }
  if (provider === 'claude') {
    return {
      models: ['sonnet', 'opus', 'haiku'].map((id) => ({
        id,
        label: id[0].toUpperCase() + id.slice(1),
        description: 'Claude Code alias · resolved by your CLI',
      })),
    };
  }
  const launch = await (options.resolve || resolveAgent)(provider);
  if (signal.aborted) throw new Error('Model loading cancelled.');
  if (provider === 'pi') {
    await verifyPiIsolation(launch, options);
    return listPiModels(launch, cwd, signal, options);
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(launch.file, [...launch.args, 'app-server', '--listen', 'stdio://'], {
      cwd,
      env: launch.env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '',
      closed = false,
      settled = false,
      stopping = false,
      stopTimer;
    let nextId = 2,
      pendingId = 1,
      pages = 0;
    let readingConfig = false;
    let defaultModel = null;
    const models = new Map();
    const cursors = new Set();
    const kill = () => {
      // An exited child may still have open pipes. Never launch a PID-based
      // helper after exit, and share one stop attempt with the EOF grace timer.
      if (closed || stopping || proc.exitCode !== null || proc.signalCode !== null) return;
      stopping = true;
      if (proc.pid && process.platform === 'win32')
        execFile(
          'taskkill.exe',
          ['/pid', String(proc.pid), '/t', '/f'],
          { windowsHide: true, timeout: 1000 },
          () => {
            if (!closed) proc.kill('SIGTERM');
          },
        );
      else proc.kill('SIGTERM');
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      proc.stdin.end();
      if (!closed) stopTimer = setTimeout(kill, 300);
      if (error) reject(error);
      else resolve({ models: [...models.values()], defaultModel });
    };
    const abort = () => {
      kill();
      finish(new Error('Model loading cancelled.'));
    };
    const timer = setTimeout(() => {
      kill();
      finish(
        new Error('Model list timed out. Check your CLI connection, then switch agents to reload.'),
      );
    }, options.timeoutMs || 15000);
    const send = (value) => {
      if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(value) + '\n');
    };
    const list = (cursor) => {
      pendingId = nextId++;
      send({
        id: pendingId,
        method: 'model/list',
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      });
    };
    const consume = (line) => {
      if (settled || !line.trim()) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.id !== undefined && e.method) {
        send({
          id: e.id,
          error: { code: -32601, message: 'OpenPE does not grant interactive requests.' },
        });
        return finish(
          new Error('Model discovery requested an interactive action. Use your CLI to resolve it.'),
        );
      }
      if (e.id !== pendingId) return;
      if (readingConfig) {
        if (!e.error && validModelId(e.result?.config?.model)) defaultModel = e.result.config.model;
        return finish();
      }
      if (e.error)
        return finish(
          new Error(
            `Could not load models: ${String(e.error.message || 'CLI request failed').slice(0, 300)}`,
          ),
        );
      if (e.id === 1) {
        send({ method: 'initialized', params: {} });
        list();
        return;
      }
      if (!Array.isArray(e.result?.data))
        return finish(new Error('The CLI returned an invalid model list. Update Codex and retry.'));
      for (const item of e.result.data) {
        if (
          !item ||
          typeof item !== 'object' ||
          !validModelId(item.model) ||
          item.hidden ||
          (Array.isArray(item.inputModalities) && !item.inputModalities.includes('text'))
        )
          continue;
        models.set(item.model, {
          id: item.model,
          label: typeof item.displayName === 'string' ? item.displayName.slice(0, 100) : item.model,
          description: item.model,
          ...(Array.isArray(item.supportedReasoningEfforts)
            ? {
                efforts: item.supportedReasoningEfforts
                  .map((e) => e?.reasoningEffort)
                  .filter((e) => ['low', 'medium', 'high'].includes(e)),
              }
            : {}),
        });
      }
      if (models.size > 500)
        return finish(new Error('The CLI returned too many models. Check your CLI configuration.'));
      const cursor = e.result.nextCursor;
      if (cursor) {
        if (
          typeof cursor !== 'string' ||
          cursor.length > 2000 ||
          cursors.has(cursor) ||
          ++pages >= 10 ||
          models.size > 500
        )
          return finish(
            new Error(
              'The CLI model list exceeded its supported size. Check your CLI configuration.',
            ),
          );
        cursors.add(cursor);
        list(cursor);
      } else {
        readingConfig = true;
        pendingId = nextId++;
        send({ id: pendingId, method: 'config/read', params: { includeLayers: false, cwd } });
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
    proc.stdout.on('data', (data) => {
      buffer += decoder.write(data);
      if (buffer.length > 2_000_000)
        return finish(new Error('The CLI model response exceeded 2 MB.'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    proc.stderr.resume();
    proc.stdin.on('error', () => finish(new Error('The model discovery connection closed.')));
    proc.on('error', (e) => finish(new Error(`Could not start model discovery: ${e.message}`)));
    proc.on('close', () => {
      closed = true;
      clearTimeout(stopTimer);
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer);
      if (!settled) finish(new Error('The CLI closed before returning its model list.'));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
