import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveAgent } from './agents.mjs';
import { validModelId } from './model-id.mjs';
import { isAgentProvider, isProviderReasoningEffort } from './agent-provider-format.mjs';
import { verifyPiIsolation } from './agent-provider-runtime.mjs';
import { listCursorModels, loadCursorSdk, readCursorApiKey } from './agent-cursor.mjs';
import { listPiModels } from './agent-pi.mjs';
import { stopOwnedProcess } from './owned-process.mjs';

// Model discovery starts no inference. Cursor receives only the key returned by
// the host reader; discovery never reads another tool's credential files.
// Claude initializes its bounded control protocol; ACP creates an empty session.
// Both close without submitting a prompt, returning only public model metadata.
export async function listAgentModels(provider, cwd, signal, options = {}) {
  if (!isAgentProvider(provider)) throw new Error('Unknown agent.');
  if (provider === 'cursor') {
    const sdk = options.sdk || (await (options.loadCursorSdk || loadCursorSdk)());
    const apiKey = await readCursorApiKey(options.cursorCredential);
    if (signal.aborted) throw new Error('Model loading cancelled.');
    return listCursorModels(apiKey, sdk, signal);
  }
  if (provider === 'deepseek') {
    const launch = await (options.resolve || resolveAgent)(provider);
    if (signal.aborted) throw new Error('Model loading cancelled.');
    const { listACPModels } = await import('./agent-acp.mjs');
    return listACPModels(provider, signal, { launch, timeoutMs: options.timeoutMs });
  }
  const launch = await (options.resolve || resolveAgent)(provider);
  if (signal.aborted) throw new Error('Model loading cancelled.');
  if (provider === 'pi') {
    await verifyPiIsolation(launch, options);
    return listPiModels(launch, cwd, signal, options);
  }
  return new Promise((resolve, reject) => {
    const args =
      provider === 'claude'
        ? [
            '-p',
            '--bare',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--no-session-persistence',
            '--tools',
            '',
            '--strict-mcp-config',
            '--mcp-config',
            '{"mcpServers":{}}',
          ]
        : ['app-server', '--listen', 'stdio://'];
    const proc = spawn(launch.file, [...launch.args, ...args], {
      cwd,
      env: launch.env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
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
      stopOwnedProcess(proc, {
        closed: () => closed,
        signal: 'SIGTERM',
        timeoutMs: 1000,
      });
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
      if (!e || typeof e !== 'object' || Array.isArray(e))
        return finish(new Error('The CLI returned an invalid model response.'));
      if (provider === 'claude') {
        if (e.type === 'control_request')
          return finish(
            new Error(
              'Model discovery requested an interactive action. Use your CLI to resolve it.',
            ),
          );
        if (e.type !== 'control_response' || e.response?.request_id !== 'openpe-models') return;
        if (e.response.subtype !== 'success')
          return finish(new Error('Could not load Claude models. Update Claude Code and retry.'));
        const catalog = e.response.response?.models;
        if (!Array.isArray(catalog) || catalog.length > 500)
          return finish(
            new Error('Claude Code returned an invalid model list. Update Claude Code and retry.'),
          );
        for (const item of catalog) {
          if (!item || !validModelId(item.value) || item.value === 'default') continue;
          const alias = ['sonnet', 'opus', 'haiku', 'fable', 'best', 'opusplan'].includes(
            item.value,
          );
          models.set(item.value, {
            id: item.value,
            label:
              typeof item.displayName === 'string' ? item.displayName.slice(0, 100) : item.value,
            description: alias
              ? 'Claude Code alias · resolved by your CLI'
              : typeof item.description === 'string'
                ? item.description.slice(0, 300)
                : item.value,
            ...(item.supportsEffort === false
              ? { efforts: [] }
              : Array.isArray(item.supportedEffortLevels)
                ? {
                    efforts: [
                      ...new Set(
                        item.supportedEffortLevels.filter((effort) =>
                          isProviderReasoningEffort('claude', effort),
                        ),
                      ),
                    ],
                  }
                : {}),
          });
        }
        return finish();
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
                  .filter((effort) => isProviderReasoningEffort('codex', effort)),
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
      if (provider === 'claude') {
        send({
          type: 'control_request',
          request_id: 'openpe-models',
          request: { subtype: 'initialize', hooks: null },
        });
        return;
      }
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
      if (!settled)
        finish(
          new Error(
            provider === 'claude'
              ? 'Claude Code closed before returning its model list. Update Claude Code for isolated model discovery and retry.'
              : 'The CLI closed before returning its model list.',
          ),
        );
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
