import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveAgent } from './agents.mjs';
import { isAgentProvider, isProviderReasoningEffort, validModelId } from './agent-provider-format.mjs';
import { rawCodexIsolationArgs, verifyPiIsolation } from './agent-provider-runtime.mjs';
import {
  listCursorModels,
  publishCursorListError,
  readCursorApiKey,
} from './agent-cursor.mjs';
import { loadCursorSdk } from './agent-cursor-sdk.mjs';
import { listPiModels } from './agent-pi.mjs';
import { stopOwnedProcess } from './owned-process.mjs';

const claudeModelAlias = /^(?:default|best|opus|sonnet|haiku|fable|opusplan)(?:\[1m\])?$/;

// Model discovery starts no inference. Cursor receives only the key returned by
// the host reader; discovery never reads another tool's credential files.
// Claude initializes its bounded control protocol; ACP creates an empty session.
// Both close without submitting a prompt, returning only public model metadata.
export async function listAgentModels(provider, cwd, signal, options = {}) {
  if (!isAgentProvider(provider)) throw new Error('Unknown agent.');
  if (provider === 'cursor') {
    let apiKey = '';
    try {
      apiKey = await readCursorApiKey(options.cursorCredential);
      if (signal.aborted) throw new Error('Model loading cancelled.');
      const sdk = options.sdk || (await (options.loadCursorSdk || loadCursorSdk)());
      return await listCursorModels(apiKey, sdk, signal);
    } catch (error) {
      throw publishCursorListError(error, apiKey);
    }
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
        : ['app-server', '--listen', 'stdio://', ...(options.raw ? rawCodexIsolationArgs : [])];
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
    let recommendedModel = null;
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
      finish(new Error('Model list timed out. Detect agents in Settings to try again.'));
    }, options.timeoutMs || 15000);
    const send = (value) => {
      if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(value) + '\n');
    };
    const list = (cursor) => {
      pendingId = nextId++;
      send({
        id: pendingId,
        method: 'model/list',
        params: { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
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
          if (item.resolvedModel !== undefined && !validModelId(item.resolvedModel))
            return finish(new Error('Claude Code returned an invalid resolved model ID.'));
          const id = item.resolvedModel ?? item.value;
          if (claudeModelAlias.test(id)) continue;
          const model = {
            id,
            label: id,
            description:
              typeof item.description === 'string' ? item.description.slice(0, 300) : id,
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
          };
          const existing = models.get(id);
          if (existing) {
            if (
              JSON.stringify(existing.efforts?.slice().sort()) !==
              JSON.stringify(model.efforts?.slice().sort())
            )
              return finish(new Error('Claude Code returned conflicting model effort metadata.'));
          } else models.set(id, model);
        }
        if (!models.size)
          return finish(
            new Error('Claude Code returned no concrete model IDs. Update Claude Code and retry.'),
          );
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
        const config = e.result?.config;
        if (!e.error && config && typeof config === 'object' && !Array.isArray(config)) {
          if (validModelId(config.model)) defaultModel = config.model;
          else if (config.model === null) defaultModel = recommendedModel;
        }
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
        if (!item || typeof item !== 'object' || !validModelId(item.model)) continue;
        const textInput =
          !Array.isArray(item.inputModalities) || item.inputModalities.includes('text');
        if (item.isDefault === true && textInput && recommendedModel === null)
          recommendedModel = item.model;
        models.set(item.model, {
          id: item.model,
          label: typeof item.displayName === 'string' ? item.displayName.slice(0, 100) : item.model,
          description: item.model,
          ...(!textInput && { textInput: false }),
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
