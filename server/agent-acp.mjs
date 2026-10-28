import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { agentName } from './agent-provider-format.mjs';
import { validModelId } from './model-id.mjs';

// All paths/configuration here are service-owned, temporary and never renderer
// inputs. The installed CLI retains responsibility for its own authentication.
export async function prepareACPWorkspace(provider) {
  if (provider !== 'deepseek') throw new Error('Unknown ACP agent.');
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-agent-'));
  try {
    await writeFile(
      path.join(directory, 'boundary.mjs'),
      await readFile(new URL('./deepseek-tool-boundary.mjs', import.meta.url)),
    );
    const patch = [
      { id: 'acp', inject: ['acpAppStartup', 'openpeToolBoundary'] },
      { id: 'agent-loop', config: { agents: [] } },
      { id: 'agent-instructions', disabled: true },
      { id: 'skill-filesystem', disabled: true },
      { id: 'session-log-deepseek', disabled: true },
      { insert: [{ id: 'openpe-tool-boundary', name: './boundary.mjs' }] },
    ];
    const patchFile = path.join(directory, 'openpe.patch.yml');
    // JSON is a YAML subset, avoiding interpolation of paths or config text.
    await writeFile(patchFile, JSON.stringify(patch));
    return { directory, args: ['--profile', 'acp', '--patch', patchFile] };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function modelCatalog(session) {
  const options = session.configOptions?.find((option) => option.id === 'model');
  function flatten(entries) {
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) throw new Error('Agent returned an invalid model catalog.');
    const result = [],
      queue = entries.map((entry) => ({ entry, depth: 0 }));
    let inspected = 0;
    while (queue.length) {
      const { entry, depth } = queue.shift();
      if (++inspected > 1000 || depth > 16 || !entry || typeof entry !== 'object')
        throw new Error('Agent model catalog exceeds its supported bounds.');
      if (entry.options !== undefined) {
        if (!Array.isArray(entry.options))
          throw new Error('Agent returned an invalid model group.');
        queue.push(...entry.options.map((entry) => ({ entry, depth: depth + 1 })));
      } else result.push(entry);
    }
    return result;
  }
  const entries = flatten(options?.options).map((entry) => ({
    id: entry.value,
    label: entry.name,
    description: entry.description,
  }));
  return {
    models: entries
      .filter((entry) => validModelId(entry.id) && typeof entry.label === 'string')
      .slice(0, 500),
    defaultModel: validModelId(options?.currentValue) ? options.currentValue : undefined,
  };
}

async function withACPSession(provider, signal, options, task) {
  if (signal.aborted) throw new Error('Agent request cancelled.');
  const workspace = await prepareACPWorkspace(provider);
  let proc;
  try {
    if (signal.aborted) throw new Error('Agent request cancelled.');
    proc = spawn(options.launch.file, [...options.launch.args, ...workspace.args], {
      cwd: workspace.directory,
      env: {
        ...options.launch.env,
        DSH_TELEMETRY_DISABLED: '1',
      },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let nextId = 0,
      buffer = '',
      stderr = '',
      closed = false,
      stopping = false;
    const decoder = new StringDecoder('utf8');
    let notify = () => {};
    function send(message) {
      if (!proc.stdin.destroyed) proc.stdin.write(JSON.stringify(message) + '\n');
    }
    function rejectAll(error) {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      pending.clear();
    }
    function kill() {
      if (closed || stopping) return;
      stopping = true;
      if (process.platform === 'win32' && proc.pid)
        execFile(
          'taskkill.exe',
          ['/pid', String(proc.pid), '/t', '/f'],
          { windowsHide: true, timeout: 3000 },
          () => {
            if (!closed) proc.kill('SIGTERM');
          },
        );
      else proc.kill('SIGTERM');
    }
    function abort() {
      rejectAll(new Error('Agent request cancelled.'));
      kill();
    }
    signal.addEventListener('abort', abort, { once: true });
    proc.stdin.on('error', (error) => rejectAll(error));
    proc.on('error', (error) => rejectAll(error));
    const exited = new Promise((resolve) =>
      proc.on('close', (code) => {
        closed = true;
        rejectAll(
          new Error(`${agentName(provider)} stopped (${code ?? 'signal'}). ${stderr.trim()}`),
        );
        resolve();
      }),
    );
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });
    proc.stdout.on('data', (chunk) => {
      if (signal.aborted || stopping) return;
      buffer += decoder.write(chunk);
      if (buffer.length > 32_000_000) {
        rejectAll(new Error('Agent protocol response is too large.'));
        kill();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        if (signal.aborted || stopping) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          rejectAll(new Error('Agent returned an invalid ACP response.'));
          kill();
          return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          rejectAll(new Error('Agent returned an invalid ACP response.'));
          kill();
          return;
        }
        if (message.method && message.id !== undefined) {
          if (message.method === 'session/request_permission')
            send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
          else
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32601,
                message: 'OpenPE does not grant filesystem, terminal or other client tools.',
              },
            });
        } else if (message.method) {
          try {
            notify(message);
          } catch (error) {
            rejectAll(error);
            kill();
          }
        } else {
          const waiter = pending.get(message.id);
          if (!waiter) continue;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error)
            waiter.reject(new Error(message.error.message || 'Agent ACP request failed.'));
          else waiter.resolve(message.result);
        }
      }
    });
    function call(method, params, timeoutMs = 30000) {
      if (closed || signal.aborted) return Promise.reject(new Error('Agent connection is closed.'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = timeoutMs
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`${agentName(provider)} did not answer ${method}.`));
              kill();
            }, timeoutMs)
          : undefined;
        pending.set(id, { resolve, reject, timer });
        send({ jsonrpc: '2.0', id, method, params });
      });
    }
    let sessionId;
    try {
      const initialized = await call('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'openpe', version: '0.1.0' },
      });
      if (initialized?.protocolVersion !== 1)
        throw new Error('This Agent does not support ACP version 1.');
      const session = await call('session/new', { cwd: workspace.directory, mcpServers: [] });
      sessionId = session?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId)
        throw new Error('Agent did not create an ACP session.');
      return await task({
        call,
        session,
        sessionId,
        initialized,
        listen: (handler) => {
          notify = handler;
        },
      });
    } finally {
      if (sessionId && !closed && !signal.aborted && !stopping)
        await call('session/close', { sessionId }, 5000).catch(() => {});
      signal.removeEventListener('abort', abort);
      if (!proc.stdin.destroyed) proc.stdin.end();
      kill();
      let exitTimer;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          exitTimer = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(exitTimer);
      rejectAll(new Error('Agent connection closed.'));
    }
  } finally {
    // workspace.directory is an exact mkdtemp result, never a user/renderer path.
    await rm(workspace.directory, { recursive: true, force: true });
  }
}

export async function listACPModels(provider, signal, options) {
  return withACPSession(provider, signal, options, async ({ session }) => modelCatalog(session));
}

export async function runACPAgent(provider, request, emit, signal, options) {
  const started = performance.now();
  try {
    return await withACPSession(
      provider,
      signal,
      options,
      async ({ call, session, sessionId, initialized, listen }) => {
        if (request.effort)
          throw new Error(`${agentName(provider)} uses its configured reasoning effort.`);
        if (request.model) {
          if (!modelCatalog(session).models.some(({ id }) => id === request.model))
            throw new Error('The selected model is not advertised by this Agent.');
          await call('session/set_config_option', {
            sessionId,
            configId: 'model',
            value: request.model,
          });
        }
        const annotations = request.annotations || [];
        if (annotations.length && !initialized.agentCapabilities?.promptCapabilities?.image)
          throw new Error(
            `${agentName(provider)} does not advertise image support. Remove the attachments or choose another Agent.`,
          );
        let hasText = false;
        listen((message) => {
          if (signal.aborted) return;
          if (message.method !== 'session/update' || message.params?.sessionId !== sessionId)
            return;
          const update = message.params.update;
          if (
            update?.sessionUpdate === 'agent_message_chunk' &&
            update.content?.type === 'text' &&
            typeof update.content.text === 'string'
          ) {
            if (update.content.text.trim()) hasText = true;
            emit({ type: 'text-delta', delta: update.content.text });
          }
          // No tool event becomes an OpenPE command or permission grant.
        });
        emit({
          type: 'status',
          stage: 'responding',
          text: `${agentName(provider)} is responding…`,
        });
        const prompt = [
          { type: 'text', text: request.prompt },
          ...annotations.map((annotation) => ({
            type: 'image',
            mimeType: 'image/png',
            data: annotation.image.dataUrl.split(',')[1],
          })),
        ];
        const result = await call('session/prompt', { sessionId, prompt }, options.timeoutMs || 0);
        if (result?.stopReason !== 'end_turn')
          throw new Error(
            `${agentName(provider)} stopped before completing the response (${result?.stopReason || 'unknown'}).`,
          );
        if (!hasText) throw new Error('The Agent returned no response content.');
        const model = request.model || modelCatalog(session).defaultModel;
        if (validModelId(model)) emit({ type: 'agent-info', model });
        return { outcome: 'completed' };
      },
    );
  } catch (error) {
    if (signal.aborted) return { outcome: 'cancelled' };
    throw error;
  } finally {
    emit({ type: 'timing', timings: { completedMs: Math.round(performance.now() - started) } });
  }
}
