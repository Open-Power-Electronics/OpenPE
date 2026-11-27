import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess, {
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { createEventNormalizer } from '../server/agent-events.mjs';
import { runAgent } from '../server/agents.mjs';
import { listAgentModels } from '../server/agent-models.mjs';
import { startServer } from '../server/index.mjs';
import { readChatEvents, responseText, type ChatEvent } from '../lib/chat-stream';

test('Codex deltas reconcile final snapshots and separate message items without duplicates', () => {
  const decode = createEventNormalizer('codex');
  const delta = (itemId: string, delta: string) =>
    decode({ method: 'item/agentMessage/delta', params: { itemId, delta } });
  assert.deepEqual(delta('a', '你'), [{ type: 'text-delta', delta: '你' }]);
  assert.deepEqual(delta('a', '好'), [{ type: 'text-delta', delta: '好' }]);
  assert.deepEqual(
    decode({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'a', text: '你好' } },
    }),
    [],
  );
  assert.deepEqual(delta('b', 'Next'), [{ type: 'text-delta', delta: '\n\nNext' }]);
  assert.deepEqual(
    decode({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'b', text: 'Corrected' } },
    }),
    [{ type: 'text-replace', text: '你好\n\nCorrected' }],
  );
  assert.equal(
    decode({ method: 'item/reasoning/summaryTextDelta', params: { delta: 'internal' } })[0].type,
    'status',
  );
  assert.equal(
    decode({ method: 'error', params: { willRetry: true, error: { message: 'network' } } })[0].type,
    'status',
  );
  assert.equal(
    decode({
      method: 'turn/completed',
      params: { turn: { status: 'failed', error: { message: 'unauthorized' } } },
    })[0].type,
    'error',
  );
});

test('Claude partial blocks, complete messages and result produce exactly one answer', () => {
  const decode = createEventNormalizer('claude');
  const stream = (event: unknown) => decode({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'm1' } });
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  assert.deepEqual(
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'First' } }),
    [{ type: 'text-delta', delta: 'First' }],
  );
  assert.deepEqual(
    stream({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'Second' },
    }),
    [{ type: 'text-delta', delta: '\nSecond' }],
  );
  assert.deepEqual(
    decode({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'First' },
          { type: 'text', text: 'Second' },
        ],
      },
    }),
    [],
  );
  assert.deepEqual(decode({ type: 'result', subtype: 'success', result: 'First\nSecond' }), [
    { type: 'complete' },
  ]);
  assert.deepEqual(
    decode({
      type: 'assistant',
      parent_tool_use_id: 'child',
      message: { content: [{ type: 'text', text: 'not main' }] },
    }),
    [],
  );
  assert.equal(
    decode({ type: 'result', is_error: true, result: 'Login required' })[0].type,
    'error',
  );
});

test('SSE parser preserves UTF-8 across byte boundaries, CRLF, keepalives and final frames', async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\n\r\ndata: {"type":"text-delta",\r\ndata: "delta":"电感 Ω"}\r\n\r\ndata: {"type":"done","outcome":"completed"}',
  );
  const events: ChatEvent[] = [];
  await readChatEvents(
    new ReadableStream({
      start(c) {
        for (const b of bytes) c.enqueue(Uint8Array.of(b));
        c.close();
      },
    }),
    (e) => events.push(e),
  );
  assert.deepEqual(events, [
    { type: 'text-delta', delta: '电感 Ω' },
    { type: 'done', outcome: 'completed' },
  ]);
});

test('incomplete proposal JSON is hidden throughout streaming', () => {
  for (let end = 1; end <= 'openpe'.length; end++)
    assert.equal(responseText('Change C2.\n```' + 'openpe'.slice(0, end)), 'Change C2.');
  assert.equal(responseText('Change C2.\n```openpe\n[{"type":"setValue"'), 'Change C2.');
  assert.equal(responseText('Before\n```openpe\n[]\n```\nAfter'), 'Before\n\nAfter');
});

test('stopping a stalled SSE read cancels the reader without waiting for source cleanup', async () => {
  const control = new AbortController();
  let cancelled = false;
  const events: ChatEvent[] = [];
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const pending = readChatEvents(body, (event) => events.push(event), control.signal);
  control.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.deepEqual(events, []);
});

test('stopping within an SSE batch discards queued text, commands and completion', async () => {
  const control = new AbortController();
  const events: ChatEvent[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            { type: 'text-delta', delta: 'Kept partial response.' },
            { type: 'text-delta', delta: 'Discarded after stop.' },
            { type: 'capability-request' },
            { type: 'done', outcome: 'completed' },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      );
    },
  });
  await assert.rejects(
    readChatEvents(
      body,
      (event) => {
        events.push(event);
        control.abort();
      },
      control.signal,
    ),
    { name: 'AbortError' },
  );
  assert.deepEqual(events, [{ type: 'text-delta', delta: 'Kept partial response.' }]);
  assert.equal(body.locked, false);
});

test('an already stopped SSE read cancels without delivering buffered content', async () => {
  const control = new AbortController();
  control.abort();
  let cancelled = false;
  const events: ChatEvent[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readChatEvents(body, (event) => events.push(event), control.signal),
    {
      name: 'AbortError',
    },
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.deepEqual(events, []);
});

const request = {
  sessionId: 'fixture-session',
  prompt: 'Test streaming',
  context: { title: 'Fixture' },
  history: [],
};
const fixture = path.resolve('tests/fixtures/agent-cli.mjs');
const resolver = (mode: string) => async () => ({
  file: process.execPath,
  args: [fixture, mode],
  env: process.env,
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function assertStopped(cwd: string) {
  const pid = Number(await readFile(path.join(cwd, 'fixture.pid'), 'utf8'));
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await pause(100);
  }
  assert.fail('The fixture child process was not cleaned up');
}

function observeModelDiscoveryChildren(t: TestContext) {
  type ObservedChild = {
    child: ChildProcess;
    command: unknown;
    args: unknown;
    windowsHide: boolean | undefined;
    events: { spawned: boolean; exited: boolean; closed: boolean };
    spawned: Promise<void>;
    exited: Promise<void>;
    closed: Promise<void>;
  };
  const observed = new Map<string, ObservedChild[]>();
  const spawn = childProcess.spawn;
  const observe = t.mock.method(childProcess, 'spawn', ((...args: unknown[]) => {
    const child = Reflect.apply(spawn, childProcess, args) as ChildProcess;
    const options = args[2] as SpawnOptions | undefined;
    const cwd = options?.cwd;
    const records = typeof cwd === 'string' ? observed.get(cwd) : undefined;
    if (records) {
      // Observe the OS child even when a timeout prevents the fixture's JS from running.
      const events = { spawned: false, exited: false, closed: false };
      records.push({
        child,
        command: args[0],
        args: args[1],
        windowsHide: options?.windowsHide,
        events,
        spawned: new Promise<void>((resolve) =>
          child.once('spawn', () => {
            events.spawned = true;
            resolve();
          }),
        ),
        exited: new Promise<void>((resolve) =>
          child.once('exit', () => {
            events.exited = true;
            resolve();
          }),
        ),
        closed: new Promise<void>((resolve) =>
          child.once('close', () => {
            events.closed = true;
            resolve();
          }),
        ),
      });
    }
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  return {
    watch(cwd: string) {
      observed.set(cwd, []);
    },
    async assertStopped(cwd: string, mode: string) {
      const records = observed.get(cwd) ?? [];
      assert.equal(records.length, 1, 'Discovery must spawn exactly the known fixture child.');
      const record = records[0];
      assert.equal(record.command, process.execPath);
      assert.equal(record.windowsHide, true);
      assert.ok(record.child.pid && record.child.pid > 0, 'The fixture must have an OS process.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([record.spawned, record.exited, record.closed]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `The fixture child was not cleaned up: ${JSON.stringify({
                      mode,
                      pid: record.child.pid,
                      ...record.events,
                      exitCode: record.child.exitCode,
                      signalCode: record.child.signalCode,
                    })}`,
                  ),
                ),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.ok(record.child.exitCode !== null || record.child.signalCode !== null);
      return record.args;
    },
    restore() {
      // Test cleanup cannot turn a missed lifecycle assertion into a pass.
      for (const records of observed.values())
        for (const { child } of records)
          if (child.pid && child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
      observe.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

test('real child transport streams before completion, sends effort and records ordered milestones', async () => {
  for (const [provider, mode] of [
    ['codex', 'codex'],
    ['claude', 'claude'],
  ] as const) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-stream-'));
    const events: any[] = [];
    const result = await runAgent(
      provider,
      { ...request, effort: 'high', model: 'fixture-model' },
      cwd,
      (e) => events.push(e),
      new AbortController().signal,
      { resolve: resolver(mode) },
    );
    assert.equal(result.outcome, 'completed');
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => e.delta)
      .join('');
    assert.equal(text, '电感 ripple.');
    const t = events.filter((e) => e.type === 'timing').at(-1).timings;
    assert.ok(
      t.firstTextMs < t.completedMs,
      'First text must arrive before the delayed completion',
    );
    assert.ok(
      t.resolvedMs <= t.spawnedMs && t.spawnedMs <= t.readyMs && t.readyMs <= t.firstTextMs,
    );
    assert.equal(events.filter((e) => e.stage === 'receiving').length, 1);
    await assertStopped(cwd);
  }
});

test('large Codex input and tool result echoes stay out of the response stream', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-codex-echo-'));
  const events: ChatEvent[] = [];
  const result = await runAgent(
    'codex',
    { ...request, effort: 'high', model: 'fixture-model' },
    cwd,
    (event) => events.push(event),
    new AbortController().signal,
    { resolve: resolver('codex-large-echo') },
  );
  assert.equal(result.outcome, 'completed', JSON.stringify(events));
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta'),
    [
      { type: 'text-delta', delta: '电感' },
      { type: 'text-delta', delta: ' ripple.' },
    ],
  );
  assert.ok(events.every((event) => JSON.stringify(event).length < 1_000));
  await assertStopped(cwd);
});

test('the Codex adapter still rejects oversized assistant output events', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-codex-output-limit-'));
  const events: ChatEvent[] = [];
  const result = await runAgent(
    'codex',
    { ...request, effort: 'high', model: 'fixture-model' },
    cwd,
    (event) => events.push(event),
    new AbortController().signal,
    { resolve: resolver('codex-oversized-answer') },
  );
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(
    events.filter((event) => event.type === 'error'),
    [{ type: 'error', text: 'Agent event exceeds the 2 MB limit.' }],
  );
  assert.equal(
    events.some((event) => event.type === 'text-delta'),
    false,
  );
  await assertStopped(cwd);
});

test('native reasoning levels reach Codex and Claude unchanged', async () => {
  for (const [provider, efforts] of [
    ['codex', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
    ['claude', ['low', 'medium', 'high', 'xhigh', 'max']],
  ] as const) {
    for (const effort of efforts) {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-effort-'));
      const events: any[] = [];
      const result = await runAgent(
        provider,
        { ...request, effort, model: 'fixture-model' },
        cwd,
        (event) => events.push(event),
        new AbortController().signal,
        { resolve: resolver(`${provider}-effort-${effort}`) },
      );
      assert.equal(result.outcome, 'completed', JSON.stringify(events));
      assert.equal(
        events.find((event) => event.type === 'agent-info')?.reasoningEffort,
        provider === 'codex' ? effort : undefined,
      );
      await assertStopped(cwd);
    }
  }
});

test('explicit Claude effort overrides only the child environment without claiming an effective level', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-claude-env-effort-'));
  const launch = await resolver('claude-effort-medium')();
  launch.env = { ...launch.env, CLAUDE_CODE_EFFORT_LEVEL: 'high' };
  const events: any[] = [];
  const result = await runAgent(
    'claude',
    { ...request, effort: 'medium', model: 'fixture-model' },
    cwd,
    (event) => events.push(event),
    new AbortController().signal,
    { resolve: async () => launch },
  );
  assert.equal(result.outcome, 'completed', JSON.stringify(events));
  assert.equal(launch.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.deepEqual(
    events.find((event) => event.type === 'agent-info'),
    { type: 'agent-info', model: 'fixture' },
  );
  await assertStopped(cwd);
});

test('Claude passes a concrete provider-qualified model and context suffix unchanged with omitted effort', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-claude-concrete-model-'));
  const events: any[] = [];
  const result = await runAgent(
    'claude',
    { ...request, model: 'provider/claude-fixture-sonnet-1[1m]' },
    cwd,
    (event) => events.push(event),
    new AbortController().signal,
    { resolve: resolver('claude-native-model') },
  );
  assert.equal(result.outcome, 'completed', JSON.stringify(events));
  assert.deepEqual(events.find((event) => event.type === 'agent-info'), {
    type: 'agent-info',
    model: 'provider/claude-fixture-sonnet-1[1m]',
  });
  await assertStopped(cwd);
});

test('Codex leaves omitted effort to the native provider for both model choices', async () => {
  for (const [mode, model] of [
    ['default-effort', undefined],
    ['codex-model-default', 'fixture-model'],
  ] as const) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-default-effort-'));
    const events: any[] = [];
    const result = await runAgent(
      'codex',
      { ...request, ...(model ? { model } : {}) },
      cwd,
      (event) => events.push(event),
      new AbortController().signal,
      { resolve: resolver(mode) },
    );
    assert.equal(result.outcome, 'completed', JSON.stringify(events));
    assert.equal(events.find((event) => event.type === 'agent-info')?.reasoningEffort, 'high');
    await assertStopped(cwd);
  }
});

test('Codex rejects a changed reasoning effort before submitting its prompt', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-clamped-effort-'));
  const events: any[] = [];
  const result = await runAgent(
    'codex',
    { ...request, effort: 'xhigh', model: 'fixture-model' },
    cwd,
    (event) => events.push(event),
    new AbortController().signal,
    { resolve: resolver('codex-clamped') },
  );
  assert.equal(result.outcome, 'failed');
  assert.match(
    events.find((event) => event.type === 'error')?.text || '',
    /did not apply the configured reasoning effort/,
  );
  await assertStopped(cwd);
});

test('cancellation, startup timeout, CLI failure, unexpected close and approval requests never report success', async (t) => {
  type ObservedChild = {
    child: ChildProcess;
    command: unknown;
    args: unknown;
    events: { spawned: boolean; exited: boolean; closed: boolean };
    spawned: Promise<void>;
    exited: Promise<void>;
    closed: Promise<void>;
  };
  const expected = new Map<string, string[]>();
  const observed = new Map<string, ObservedChild[]>();
  const spawn = childProcess.spawn;
  const observe = t.mock.method(childProcess, 'spawn', ((...args: unknown[]) => {
    const child = Reflect.apply(spawn, childProcess, args) as ChildProcess;
    const cwd = (args[2] as SpawnOptions | undefined)?.cwd;
    if (typeof cwd === 'string' && expected.has(cwd)) {
      const events = { spawned: false, exited: false, closed: false };
      observed.set(cwd, [
        ...(observed.get(cwd) ?? []),
        {
          child,
          command: args[0],
          args: args[1],
          events,
          spawned: new Promise<void>((resolve) =>
            child.once('spawn', () => {
              events.spawned = true;
              resolve();
            }),
          ),
          exited: new Promise<void>((resolve) =>
            child.once('exit', () => {
              events.exited = true;
              resolve();
            }),
          ),
          closed: new Promise<void>((resolve) =>
            child.once('close', () => {
              events.closed = true;
              resolve();
            }),
          ),
        },
      ]);
    }
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    for (const mode of [
      'cancel',
      'handshake-hang',
      'failure',
      'disconnect',
      'approval',
      'timeout-before-pid',
    ]) {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-stop-'));
      const launch = await resolver(mode === 'timeout-before-pid' ? 'handshake-hang' : mode)();
      if (mode === 'timeout-before-pid')
        launch.args.unshift(
          '--import',
          'data:text/javascript,' +
            encodeURIComponent('await new Promise((resolve) => setTimeout(resolve, 15000));'),
        );
      expected.set(cwd, [
        ...launch.args,
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        'features.shell_tool=false',
        '-c',
        'web_search="disabled"',
        '-c',
        'mcp_servers={}',
      ]);
      const events: any[] = [];
      const controller = new AbortController();
      const pending = runAgent(
        'codex',
        request,
        cwd,
        (e) => {
          events.push(e);
          if (mode === 'cancel' && e.type === 'text-delta') controller.abort();
        },
        controller.signal,
        {
          resolve: async () => launch,
          timeoutMs: mode === 'handshake-hang' || mode === 'timeout-before-pid' ? 700 : 5000,
        },
      );
      try {
        const result = await pending;
        assert.equal(result.outcome, mode === 'cancel' ? 'cancelled' : 'failed');
        if (mode !== 'cancel') assert.ok(events.some((e) => e.type === 'error'));
      } finally {
        controller.abort();
        await pending.catch(() => {});
      }
      const records = observed.get(cwd) ?? [];
      assert.equal(records.length, 1, 'The transport must spawn exactly the known fixture child.');
      const record = records[0];
      assert.equal(record.command, process.execPath);
      assert.deepEqual(record.args, expected.get(cwd));
      assert.ok(record.child.pid && record.child.pid > 0, 'The fixture must have an OS process.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([record.spawned, record.exited, record.closed]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `The transport fixture child was not cleaned up: ${JSON.stringify({
                      mode,
                      pid: record.child.pid,
                      ...record.events,
                      exitCode: record.child.exitCode,
                      signalCode: record.child.signalCode,
                    })}`,
                  ),
                ),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.ok(record.child.exitCode !== null || record.child.signalCode !== null);
      if (mode === 'timeout-before-pid')
        await assert.rejects(readFile(path.join(cwd, 'fixture.pid'), 'utf8'), { code: 'ENOENT' });
    }
  } finally {
    for (const records of observed.values())
      for (const { child } of records)
        if (child.pid && child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
    observe.mock.restore();
    syncBuiltinESMExports();
  }
});

test('local SSE sends increments immediately, validates model/effort and aborts on client disconnect', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-http-'));
  let requestSeen: any;
  let aborted!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const server = await startServer({
    dataDir: cwd,
    agentRunner: async (_p, req, _cwd, emit, signal) => {
      requestSeen = req;
      emit({ type: 'text-delta', delta: 'First' });
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted();
            resolve();
          },
          { once: true },
        ),
      );
      return { outcome: 'cancelled' };
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  try {
    for (const sessionId of [undefined, null, '', 'with spaces', 'x'.repeat(81)]) {
      const invalid = await fetch(server.base + '/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, provider: 'codex', sessionId }),
      });
      assert.equal(invalid.status, 400);
    }
    const bad = await fetch(server.base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...request, provider: 'codex', effort: 'unsupported' }),
    });
    assert.equal(bad.status, 400);
    for (const requestTitle of ['yes', 1, null, {}]) {
      const invalid = await fetch(server.base + '/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, provider: 'codex', requestTitle }),
      });
      assert.equal(invalid.status, 400);
    }
    for (const model of ['', '--help', 'bad\nmodel', 123, 'x'.repeat(201)]) {
      const invalid = await fetch(server.base + '/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...request, provider: 'codex', model }),
      });
      assert.equal(invalid.status, 400);
    }
    const controller = new AbortController();
    const response = await fetch(server.base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...request,
        provider: 'codex',
        effort: 'low',
        model: 'fixture-model',
        requestTitle: true,
      }),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let received = '';
    while (!received.includes('First')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      received += new TextDecoder().decode(chunk.value);
    }
    assert.equal(requestSeen.effort, 'low');
    assert.equal(requestSeen.model, 'fixture-model');
    assert.equal(requestSeen.requestTitle, true);
    controller.abort();
    await Promise.race([
      disconnected,
      pause(2000).then(() => {
        throw new Error('Disconnect did not abort the agent');
      }),
    ]);
  } finally {
    server.close();
  }
});

test('session streams run independently, reject duplicates and all stop at shutdown', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-sessions-'));
  const stopped = new Set<string>();
  const lifecycle = new EventEmitter();
  const firstRequest = new AbortController();
  const server = await startServer({
    dataDir: cwd,
    agentRunner: async (_provider, req, _cwd, emit, signal) => {
      const aborted = once(signal, 'abort');
      emit({ type: 'text-delta', delta: req.sessionId });
      lifecycle.emit('started', req.sessionId);
      await aborted;
      stopped.add(req.sessionId!);
      lifecycle.emit('stopped', req.sessionId);
      return { outcome: 'cancelled' };
    },
  });
  const send = (sessionId: string, signal?: AbortSignal) =>
    fetch(server.base + '/api/chat', {
      method: 'POST',
      headers: { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, provider: 'codex', sessionId }),
      signal,
    });
  const responses: Response[] = [];
  try {
    for (const id of ['one', 'two', 'three', 'four']) {
      const [[started], response] = await Promise.all([
        once(lifecycle, 'started', { signal: AbortSignal.timeout(5000) }),
        send(id, id === 'one' ? firstRequest.signal : undefined),
      ]);
      assert.equal(response.status, 200);
      assert.equal(started, id);
      responses.push(response);
    }
    assert.equal((await send('one')).status, 409);
    assert.equal((await send('five')).status, 429);
    assert.equal((await send('../invalid')).status, 400);
    const cancelled = once(lifecycle, 'stopped', { signal: AbortSignal.timeout(5000) });
    firstRequest.abort();
    assert.deepEqual(await cancelled, ['one']);
    assert.deepEqual([...stopped], ['one'], 'Cancelling one session preserves the others.');
  } finally {
    server.close();
    await Promise.all(responses.slice(1).map((response) => response.text()));
  }
  assert.deepEqual([...stopped].sort(), ['four', 'one', 'three', 'two']);
});

test('Codex discovery keeps hidden and new models across pages and describes input support', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-models-'));
  const result = await listAgentModels('codex', cwd, new AbortController().signal, {
    resolve: resolver('catalog'),
  });
  assert.deepEqual(result.models, [
    {
      id: 'fixture-model',
      label: 'Fixture Model',
      description: 'fixture-model',
      efforts: ['low', 'none', 'minimal', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', description: 'gpt-6.2-astra' },
    { id: 'image-input', label: 'image-input', description: 'image-input', textInput: false },
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', description: 'gpt-6.2-sol', efforts: [] },
  ]);
  assert.equal(
    result.defaultModel,
    'configured-model',
    'Effective config wins over the recommended catalog default, including IDs outside the catalog.',
  );
  await assertStopped(cwd);
});

test('Claude discovers concrete models, deduplicates resolutions and preserves effort capabilities without account metadata', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-claude-models-'));
  const result = await listAgentModels('claude', cwd, new AbortController().signal, {
    resolve: resolver('claude-catalog'),
  });
  assert.deepEqual(result, {
    defaultModel: null,
    models: [
      {
        id: 'claude-fixture-opus-1',
        label: 'claude-fixture-opus-1',
        description: 'Fixture Opus model',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: 'claude-fixture-sonnet-1[1m]',
        label: 'claude-fixture-sonnet-1[1m]',
        description: 'claude-fixture-sonnet-1[1m]',
        efforts: ['low', 'medium', 'high'],
      },
      {
        id: 'claude-fixture-haiku-1',
        label: 'claude-fixture-haiku-1',
        description: 'claude-fixture-haiku-1',
        efforts: [],
      },
      {
        id: 'provider/fixture-custom',
        label: 'provider/fixture-custom',
        description: 'Custom model',
      },
      {
        id: 'fixture-missing-levels',
        label: 'fixture-missing-levels',
        description: 'fixture-missing-levels',
      },
      {
        id: 'fixture-invalid-levels',
        label: 'fixture-invalid-levels',
        description: 'fixture-invalid-levels',
      },
    ],
  });
  assert.equal(JSON.stringify(result).includes('private@example.invalid'), false);
  await assertStopped(cwd);
});

test('Claude concrete model discovery rejects malformed resolutions, missing models and conflicting effort metadata', async () => {
  for (const [mode, expected] of [
    ['claude-catalog-unresolved-only', /no concrete model IDs/],
    ['claude-catalog-default-only', /no concrete model IDs/],
    ['claude-catalog-invalid-resolved', /invalid resolved model ID/],
    ['claude-catalog-null-resolved', /invalid resolved model ID/],
    ['claude-catalog-conflicting-effort', /conflicting model effort metadata/],
    ['claude-catalog-conflicting-unknown-effort', /conflicting model effort metadata/],
  ] as const) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-claude-model-resolution-'));
    await assert.rejects(
      listAgentModels('claude', cwd, new AbortController().signal, {
        resolve: resolver(mode),
      }),
      expected,
    );
    await assertStopped(cwd);
  }
});

test('Claude model discovery rejects interactive requests, failures and timeouts', async (t) => {
  const children = observeModelDiscoveryChildren(t);
  try {
    for (const [mode, expected] of [
      ['claude-catalog-interactive', /interactive action/],
      ['claude-catalog-error', /Could not load Claude models/],
      ['claude-catalog-null', /invalid model response/],
      ['claude-catalog-array', /invalid model response/],
      ['claude-catalog-hang', /timed out/],
    ] as const) {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-claude-model-failure-'));
      const timesOut = mode === 'claude-catalog-hang';
      if (timesOut) children.watch(cwd);
      await assert.rejects(
        listAgentModels('claude', cwd, new AbortController().signal, {
          resolve: resolver(mode),
          timeoutMs: timesOut ? 500 : 15000,
        }),
        expected,
      );
      if (timesOut) {
        const args = await children.assertStopped(cwd, mode);
        assert.ok(Array.isArray(args));
        assert.deepEqual(args.slice(0, 2), [fixture, mode]);
      } else {
        await assertStopped(cwd);
      }
    }
  } finally {
    children.restore();
  }
});

test('Codex discovery uses the native recommendation when config has no model', async () => {
  for (const [mode, expected] of [
    ['catalog-config-error', null],
    ['catalog-no-default', null],
    ['catalog-recommended', 'fixture-model'],
  ] as const) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-config-'));
    const result = await listAgentModels('codex', cwd, new AbortController().signal, {
      resolve: resolver(mode),
    });
    assert.equal(result.models.length, 4);
    assert.equal(result.defaultModel, expected);
    await assertStopped(cwd);
  }
});

test('model discovery errors, approval requests, timeout and cancellation never leave a child running', async (t) => {
  const children = observeModelDiscoveryChildren(t);
  try {
    for (const mode of [
      'catalog-error',
      'catalog-approval',
      'catalog-hang',
      'cancel',
      'timeout-before-pid',
    ]) {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-stop-'));
      const launch = await resolver(
        mode === 'cancel' || mode === 'timeout-before-pid' ? 'catalog-hang' : mode,
      )();
      if (mode === 'timeout-before-pid')
        // Delay fixture evaluation, keeping the real Node child alive until the
        // unchanged discovery timeout. No PID file can be written first.
        launch.args.unshift(
          '--import',
          'data:text/javascript,' +
            encodeURIComponent('await new Promise((resolve) => setTimeout(resolve, 15000));'),
        );
      children.watch(cwd);
      const control = new AbortController();
      const pending = listAgentModels('codex', cwd, control.signal, {
        resolve: async () => launch,
        timeoutMs: mode === 'cancel' ? 15000 : 700,
      });
      const settled = pending.catch(() => {});
      try {
        if (mode === 'cancel') {
          const deadline = Date.now() + 10000;
          while (true) {
            try {
              if ((await readFile(path.join(cwd, 'fixture.pid'), 'utf8')).trim()) break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            assert.ok(Date.now() < deadline, 'The fixture did not start before cancellation.');
            await pause(20);
          }
          control.abort();
        }
        if (mode === 'cancel') await assert.rejects(pending, /cancelled/);
        else if (mode === 'timeout-before-pid') await assert.rejects(pending, /timed out/);
        else await assert.rejects(pending);
      } finally {
        control.abort();
        await settled;
      }
      const args = await children.assertStopped(cwd, mode);
      assert.deepEqual(args, [...launch.args, 'app-server', '--listen', 'stdio://']);
      if (mode === 'timeout-before-pid')
        await assert.rejects(readFile(path.join(cwd, 'fixture.pid'), 'utf8'), { code: 'ENOENT' });
    }
  } finally {
    children.restore();
  }
});

for (const transport of ['model discovery', 'agent transport'] as const) {
  for (const failure of ['launch-error', 'timeout'] as const)
    test(
      `${transport} Windows cleanup falls back after taskkill ${failure}`,
      {
        skip: process.platform !== 'win32',
      },
      async (t) => {
        const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-kill-fallback-'));
        const spawn = childProcess.spawn;
        let child: ChildProcess | undefined;
        let exited: Promise<void> | undefined;
        let closed: Promise<void> | undefined;
        const helpers: ExecFileOptions[] = [];
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const observe = t.mock.method(childProcess, 'spawn', ((...args: unknown[]) => {
          const result = Reflect.apply(spawn, childProcess, args) as ChildProcess;
          assert.equal((args[2] as SpawnOptions).cwd, cwd);
          assert.equal(child, undefined, 'Only the known fixture child may be spawned.');
          child = result;
          exited = new Promise<void>((resolve) => result.once('exit', () => resolve()));
          closed = new Promise<void>((resolve) => result.once('close', () => resolve()));
          return result;
        }) as typeof childProcess.spawn);
        const taskkill = t.mock.method(childProcess, 'execFile', ((
          file: string,
          args: readonly string[],
          options: ExecFileOptions,
          callback: (error: Error, stdout: string, stderr: string) => void,
        ) => {
          assert.equal(file, path.win32.join(process.env.SystemRoot || '', 'System32', 'taskkill.exe'));
          assert.ok(child?.pid);
          assert.deepEqual(args, ['/pid', String(child.pid), '/t', '/f']);
          assert.equal(options.windowsHide, true);
          helpers.push(options);
          // Keep the child alive across finish's EOF grace to catch duplicate
          // helpers. Only this callback is simulated; the original child must exit.
          const timer = setTimeout(
            () => {
              timers.delete(timer);
              const error = Object.assign(
                new Error(`Fixture taskkill ${failure}`),
                failure === 'launch-error'
                  ? { code: 'ENOENT' }
                  : { killed: true, signal: 'SIGTERM' },
              );
              callback(error, '', '');
            },
            failure === 'launch-error' ? 400 : 1000,
          );
          timers.add(timer);
          return child;
        }) as typeof childProcess.execFile);
        syncBuiltinESMExports();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const launch = await resolver('catalog-hang')();
          launch.args.unshift(
            '--import',
            'data:text/javascript,' +
              encodeURIComponent('await new Promise((resolve) => setTimeout(resolve, 15000));'),
          );
          if (transport === 'model discovery')
            await assert.rejects(
              listAgentModels('codex', cwd, new AbortController().signal, {
                resolve: async () => launch,
                timeoutMs: 50,
              }),
              /timed out/,
            );
          else {
            const events: ChatEvent[] = [];
            const result = await runAgent(
              'codex',
              request,
              cwd,
              (e) => events.push(e),
              new AbortController().signal,
              {
                resolve: async () => launch,
                timeoutMs: 50,
              },
            );
            assert.equal(result.outcome, 'failed');
            assert.ok(events.some((e) => e.type === 'error'));
          }
          assert.ok(child?.pid);
          assert.ok(exited && closed);
          await Promise.race([
            Promise.all([exited, closed]),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`No owned-child fallback after ${failure}.`)),
                3000,
              );
            }),
          ]);
          assert.ok(child.exitCode !== null || child.signalCode !== null);
          assert.equal(helpers.length, 1, 'Timeout and EOF grace share one cleanup attempt.');
          assert.equal(helpers[0].timeout, 1000);
          await assert.rejects(readFile(path.join(cwd, 'fixture.pid'), 'utf8'), { code: 'ENOENT' });
        } finally {
          clearTimeout(timer);
          for (const pending of timers) clearTimeout(pending);
          // A failed regression still reaps only its own fixture. This cannot turn
          // the preceding lifecycle failure into a successful assertion.
          try {
            if (child && child.exitCode === null && child.signalCode === null)
              child.kill('SIGKILL');
            if (closed) {
              let reapTimer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  closed,
                  new Promise<never>((_resolve, reject) => {
                    reapTimer = setTimeout(
                      () => reject(new Error('Owned fixture cleanup did not close.')),
                      1500,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(reapTimer);
              }
            }
          } finally {
            observe.mock.restore();
            taskkill.mock.restore();
            syncBuiltinESMExports();
          }
        }
      },
    );

  test(
    `${transport} Windows cleanup never taskkills an exited child with delayed close`,
    {
      skip: process.platform !== 'win32',
    },
    async (t) => {
      const child = new childProcess.ChildProcess();
      Object.assign(child, {
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      let helpers = 0;
      let directKills = 0;
      const streams = [child.stdin!, child.stdout!, child.stderr!];
      const spawn = t.mock.method(childProcess, 'spawn', (() => {
        queueMicrotask(() => {
          child.emit('spawn');
          Object.defineProperty(child, 'exitCode', { value: 0 });
          child.emit('exit', 0, null);
        });
        return child;
      }) as typeof childProcess.spawn);
      const taskkill = t.mock.method(childProcess, 'execFile', ((
        _file: string,
        _args: readonly string[],
        _options: ExecFileOptions,
        _callback: (error: Error, stdout: string, stderr: string) => void,
      ) => {
        helpers++;
        return child;
      }) as typeof childProcess.execFile);
      t.mock.method(child, 'kill', () => {
        directKills++;
        return false;
      });
      syncBuiltinESMExports();
      const close = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const timer = setTimeout(() => child.emit('close', 0, null), 400);
      try {
        if (transport === 'model discovery')
          await assert.rejects(
            listAgentModels('codex', 'fixture-exited-child', new AbortController().signal, {
              resolve: resolver('catalog-hang'),
              timeoutMs: 50,
            }),
            /timed out/,
          );
        else {
          const result = await runAgent(
            'codex',
            request,
            'fixture-exited-child',
            () => {},
            new AbortController().signal,
            {
              resolve: resolver('catalog-hang'),
              timeoutMs: 50,
            },
          );
          assert.equal(result.outcome, 'failed');
        }
        await close;
        assert.equal(helpers, 0, 'An exited PID must never be handed to a new taskkill process.');
        assert.equal(directKills, 0);
      } finally {
        clearTimeout(timer);
        for (const stream of streams) stream.destroy();
        spawn.mock.restore();
        taskkill.mock.restore();
        syncBuiltinESMExports();
      }
    },
  );
}

test('stopped sessions accept a successor before delayed cleanup without releasing the successor slot', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-session-restart-'));
  let firstAborted!: () => void;
  const disconnected = new Promise<void>((resolve) => (firstAborted = resolve));
  let releaseFirstCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => (releaseFirstCleanup = resolve));
  let firstFinished!: () => void;
  const finished = new Promise<void>((resolve) => (firstFinished = resolve));
  const signals = new Map<string, AbortSignal>();
  const starts = new Map<string, () => void>();
  const ready = (prompt: string) => new Promise<void>((resolve) => starts.set(prompt, resolve));
  const firstReady = ready('first turn');
  const otherReady = ready('other turn');
  const successorReady = ready('successor turn');
  let cleanupFinished = false;
  const server = await startServer({
    dataDir: cwd,
    agentRunner: async (_provider, req, _cwd, emit, signal) => {
      signals.set(req.prompt, signal);
      starts.get(req.prompt)?.();
      emit({ type: 'text-delta', delta: req.prompt });
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      if (req.prompt === 'first turn') {
        firstAborted();
        await cleanup;
        cleanupFinished = true;
        firstFinished();
      }
      return { outcome: 'cancelled' };
    },
  });
  const send = (sessionId: string, prompt: string) =>
    fetch(server.base + '/api/chat', {
      method: 'POST',
      headers: { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, provider: 'codex', sessionId, prompt }),
    });
  const responses: Response[] = [];
  try {
    const first = await send('restarted', 'first turn');
    const other = await send('independent', 'other turn');
    responses.push(first, other);
    assert.equal(first.status, 200);
    assert.equal(other.status, 200);
    // SSE headers can arrive while bundled guidance is still being prepared.
    // This regression specifically exercises delayed cleanup of a running adapter.
    await Promise.all([firstReady, otherReady]);
    await first.body!.cancel();
    await Promise.race([
      disconnected,
      pause(2000).then(() => {
        throw new Error('Stopping did not cancel the first turn.');
      }),
    ]);

    const successor = await send('restarted', 'successor turn');
    responses.push(successor);
    assert.equal(successor.status, 200, 'Cancelled cleanup must not block the next message.');
    await successorReady;
    assert.equal(cleanupFinished, false, 'The successor starts while old cleanup is pending.');
    assert.equal((await send('restarted', 'duplicate before cleanup')).status, 409);
    assert.equal(signals.get('other turn')?.aborted, false);

    releaseFirstCleanup();
    await finished;
    assert.equal((await send('restarted', 'duplicate after cleanup')).status, 409);
    assert.equal(signals.get('successor turn')?.aborted, false);
    assert.equal(signals.get('other turn')?.aborted, false);
    assert.equal((await send('independent', 'other duplicate')).status, 409);
  } finally {
    releaseFirstCleanup();
    server.close();
    await Promise.all(responses.map((response) => response.body!.cancel().catch(() => {})));
  }
});
