import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { piIsolationFlags } from './agent-provider-runtime.mjs';
import { createEventNormalizer } from './agent-events.mjs';
import { validModelId } from './model-id.mjs';

// The Pi client sends only state/catalog queries and one prompt. The RPC bash,
// resource, session-file and extension control commands are never exposed.
function piRPC(launch, cwd, signal, options, handlers) {
  if (signal.aborted) return Promise.reject(new Error('Pi connection cancelled.'));
  return new Promise((resolve, reject) => {
    const proc = spawn(
      launch.file,
      [
        ...launch.args,
        '--mode',
        'rpc',
        ...piIsolationFlags,
        ...(options.model ? ['--model', options.model] : []),
        ...(options.effort ? ['--thinking', options.effort] : []),
      ],
      { cwd, env: launch.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const decoder = new StringDecoder('utf8');
    let buffer = '',
      stderr = '',
      settled = false,
      closed = false,
      stopping = false,
      stopTimer;
    const kill = () => {
      if (closed || stopping) return;
      stopping = true;
      if (proc.pid && process.platform === 'win32')
        execFile(
          'taskkill.exe',
          ['/pid', String(proc.pid), '/t', '/f'],
          { windowsHide: true, timeout: 3000 },
          () => {
            if (!closed) proc.kill();
          },
        );
      else proc.kill('SIGTERM');
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      proc.stdin.end();
      if (error) {
        kill();
        reject(error);
      } else {
        if (!closed) stopTimer = setTimeout(kill, 500);
        resolve(result);
      }
    };
    const abort = () => finish(new Error('Pi connection cancelled.'));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            options.timeoutMessage ||
              'Pi connection timed out. Check the CLI connection and retry.',
          ),
        ),
      options.timeoutMs || 300000,
    );
    const send = (record) => {
      if (!settled && !proc.stdin.destroyed) proc.stdin.write(JSON.stringify(record) + '\n');
    };
    const consume = (line) => {
      if (settled || !line.trim()) return;
      if (line.length > 2_000_000) return finish(new Error('Pi event exceeds the 2 MB limit.'));
      try {
        const event = JSON.parse(line);
        if (event.type === 'response' && event.success === false)
          throw new Error(
            `Pi request failed: ${String(event.error || event.command || 'Unknown error').slice(0, 4000)}`,
          );
        if (event.type === 'extension_ui_request' || event.type?.startsWith('tool_execution_'))
          throw new Error(
            'Pi attempted a tool or interactive action in an isolated OpenPE session.',
          );
        handlers.record(event, send, (value) => finish(null, value));
      } catch (error) {
        finish(error);
      }
    };
    proc.on('spawn', () => {
      if (signal.aborted) return abort();
      try {
        handlers.start(send);
      } catch (error) {
        finish(error);
      }
    });
    proc.stdout.on('data', (data) => {
      if (settled) return;
      buffer += decoder.write(data);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 2_000_000) finish(new Error('Pi event exceeds the 2 MB limit.'));
    });
    proc.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });
    proc.stdin.on('error', (error) =>
      finish(new Error(`Pi input connection failed: ${error.message}`)),
    );
    proc.on('error', (error) => finish(new Error(`Could not start Pi: ${error.message}`)));
    proc.on('close', (code) => {
      closed = true;
      clearTimeout(stopTimer);
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer);
      if (!settled)
        finish(
          new Error(
            `Pi disconnected before completing the request (exit ${code}). ${stderr.trim()}`,
          ),
        );
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function runPiAgent(request, prompt, launch, cwd, emit, signal, options = {}) {
  const started = performance.now();
  const timings = {};
  const mark = (key) => {
    if (timings[key] !== undefined) return;
    timings[key] = Math.round(performance.now() - started);
    emit({ type: 'timing', timings: { ...timings } });
  };
  const normalize = createEventNormalizer('pi');
  let submitted = false,
    hasText = false;
  emit({ type: 'status', stage: 'starting', text: 'Starting Pi…' });
  try {
    await piRPC(
      launch,
      cwd,
      signal,
      { ...options, model: request.model, effort: request.effort },
      {
        start(send) {
          mark('spawnedMs');
          emit({ type: 'status', stage: 'initializing', text: 'Connecting to Pi…' });
          send({ id: 'openpe-state', type: 'get_state' });
        },
        record(event, send, finish) {
          mark('firstEventMs');
          if (event.type === 'response' && event.id === 'openpe-state' && !submitted) {
            submitted = true;
            mark('readyMs');
            const state = event.data || {};
            emit({
              type: 'agent-info',
              model: state.model?.id,
              reasoningEffort: state.thinkingLevel,
            });
            mark('submittedMs');
            send({
              id: 'openpe-prompt',
              type: 'prompt',
              message: prompt,
              ...(request.annotations?.length
                ? {
                    images: request.annotations.map((annotation) => ({
                      type: 'image',
                      mimeType: 'image/png',
                      data: annotation.image.dataUrl.slice('data:image/png;base64,'.length),
                    })),
                  }
                : {}),
            });
            return;
          }
          if (
            event.type === 'response' &&
            event.id === 'openpe-prompt' &&
            event.data?.disposition === 'handled'
          )
            throw new Error('Pi did not start a model response for this request.');
          for (const item of normalize(event)) {
            if (item.type === 'error') throw new Error(item.text);
            if (item.type === 'complete') {
              if (!submitted || !hasText)
                throw new Error('No content returned. Check your Pi model and sign-in.');
              finish();
            } else {
              if (item.type === 'text-delta' || item.type === 'text-replace') {
                hasText = true;
                mark('firstTextMs');
              }
              emit(item);
            }
          }
        },
      },
    );
    mark('completedMs');
    return { outcome: 'completed', timings };
  } catch (error) {
    mark('completedMs');
    if (signal.aborted) return { outcome: 'cancelled', timings };
    emit({ type: 'error', text: error.message });
    return { outcome: 'failed', timings };
  }
}

export async function listPiModels(launch, cwd, signal, options = {}) {
  let models,
    defaultModel = null,
    stateReceived = false;
  return piRPC(
    launch,
    cwd,
    signal,
    { ...options, timeoutMs: options.timeoutMs || 15000 },
    {
      start(send) {
        send({ id: 'openpe-models', type: 'get_available_models' });
        send({ id: 'openpe-state', type: 'get_state' });
      },
      record(event, _send, finish) {
        if (event.type !== 'response') return;
        if (event.id === 'openpe-models') {
          if (!Array.isArray(event.data?.models))
            throw new Error('Pi returned an invalid model list.');
          if (event.data.models.length > 500)
            throw new Error('Pi returned more than 500 models. Narrow the CLI configuration.');
          const unique = new Map();
          for (const item of event.data.models) {
            const id = `${item?.provider}/${item?.id}`;
            if (
              !validModelId(item?.id) ||
              !validModelId(item?.provider) ||
              !validModelId(id) ||
              (Array.isArray(item.input) && !item.input.includes('text'))
            )
              continue;
            unique.set(id, {
              id,
              label: typeof item.name === 'string' ? item.name.slice(0, 100) : item.id,
              description: id,
              ...(item.reasoning ? { efforts: ['low', 'medium', 'high'] } : {}),
            });
          }
          models = [...unique.values()];
        }
        if (event.id === 'openpe-state') {
          stateReceived = true;
          const model = event.data?.model;
          const id = `${model?.provider}/${model?.id}`;
          if (validModelId(model?.provider) && validModelId(model?.id) && validModelId(id))
            defaultModel = id;
        }
        if (models && stateReceived) finish({ models, defaultModel });
      },
    },
  );
}
