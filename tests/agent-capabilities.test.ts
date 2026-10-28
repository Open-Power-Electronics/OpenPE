import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentCapabilityBridge,
  validateAgentCapabilityCall,
  boundedAgentJSON,
} from '../server/agent-capabilities.mjs';
import { agentMCPConnection, startAgentMCP } from '../server/agent-mcp.mjs';
import { startServer } from '../server/index.mjs';
import { runAgent } from '../server/agents.mjs';
import { ProjectCore } from '../core/project-core';
import { createCapabilityHost } from '../api/capabilities';
import { registerProjectCapabilities } from '../core/register-project';
import { createProject } from '../lib/project';
import { createPart, emptyCircuit, pinPositions, uid } from '../lib/circuit';
import { samePoint } from '../lib/wiring';
import { switchingStageFixture } from './fixtures/switching-stage';
import {
  resolveAgentCapability,
  readChatEvents,
  type AgentCapabilities,
  type AgentCapabilityRequest,
  type AgentCommandReview,
} from '../lib/chat-stream';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function bridgeFixture(timeoutMs = 1000) {
  const events: AgentCapabilityRequest[] = [];
  const control = new AbortController();
  const bridge = createAgentCapabilityBridge({
    sessionId: 'session',
    origin: 'origin',
    emit: (event: AgentCapabilityRequest) => events.push(event),
    signal: control.signal,
    timeoutMs,
  });
  const answer = (event: AgentCapabilityRequest, result: unknown) =>
    bridge.respond(
      {
        sessionId: event.sessionId,
        runId: event.runId,
        requestId: event.requestId,
        token: event.token,
        result,
      },
      'origin',
    );
  return { bridge, events, control, answer };
}

test('capability tools reject unsupported names, invalid cursors, revisions, recursive or oversized JSON', () => {
  for (const [tool, args] of [
    ['shell', { name: 'run' }],
    ['openpe_query', { name: '../files' }],
    ['openpe_query', { name: 'project.snapshot', path: 'private' }],
    ['openpe_observe', { after: -1 }],
    ['openpe_observe', { after: 0.5 }],
    ['openpe_execute', { name: 'project.replace', expectedRevision: '' }],
  ])
    assert.throws(() => validateAgentCapabilityCall(tool, args));
  assert.doesNotThrow(() =>
    validateAgentCapabilityCall('openpe_execute', {
      name: 'project.replace',
      input: { source: '{}' },
      expectedRevision: '1',
    }),
  );
  assert.throws(() => boundedAgentJSON({ value: Infinity }, 100));
  assert.throws(() => boundedAgentJSON({ value: 'long' }, 5));
  const recursive: any = {};
  recursive.self = recursive;
  assert.throws(() => boundedAgentJSON(recursive, 100));
});

test('a tool response is bound to the live originating session, run, origin and one-time token', async () => {
  const { bridge, events, answer } = bridgeFixture();
  try {
    const pending = bridge.call('openpe_query', { name: 'project.snapshot' });
    const event = events[0];
    for (const overrides of [
      { sessionId: 'other' },
      { runId: 'other' },
      { token: 'x'.repeat(64) },
    ]) {
      assert.throws(() =>
        bridge.respond({ ...event, type: undefined, ...overrides, result: {} }, 'origin'),
      );
    }
    assert.throws(() =>
      bridge.respond(
        {
          runId: event.runId,
          sessionId: event.sessionId,
          requestId: event.requestId,
          token: event.token,
          result: {},
        },
        'another-origin',
      ),
    );
    answer(event, { revision: 7 });
    assert.deepEqual(await pending, { revision: 7 });
    assert.throws(() => answer(event, {}), /already answered/);
    assert.equal(bridge.authorized('invalid'), false);
    assert.equal(bridge.authorized(bridge.token), true);
  } finally {
    bridge.close();
  }
  assert.equal(bridge.authorized(bridge.token), false);
});

test('query timeout, cancellation, concurrency and total request budgets release pending calls', async () => {
  const timed = bridgeFixture(10);
  await assert.rejects(timed.bridge.call('openpe_observe', {}), /in time/);
  timed.bridge.close();
  const fixture = bridgeFixture();
  const pending = Array.from({ length: 4 }, () =>
    fixture.bridge.call('openpe_query', { name: 'project.snapshot' }),
  );
  await assert.rejects(fixture.bridge.call('openpe_query', { name: 'project.snapshot' }), /limit/);
  fixture.control.abort();
  for (const promise of pending) await assert.rejects(promise, /cancelled/);
  await assert.rejects(fixture.bridge.call('openpe_observe', {}), /no longer active/);
  const total = bridgeFixture();
  try {
    for (let i = 0; i < 256; i++) {
      const promise = total.bridge.call('openpe_observe', {});
      total.answer(total.events.at(-1)!, { cursor: i, events: [] });
      await promise;
    }
    await assert.rejects(total.bridge.call('openpe_observe', {}), /limit/);
  } finally {
    total.bridge.close();
  }
});

test('execute waits for the host without imposing the query timeout on simulation runtime', async () => {
  const fixture = bridgeFixture(5);
  try {
    const pending = fixture.bridge.call('openpe_execute', { name: 'simulation.run' });
    await pause(25);
    assert.equal(fixture.bridge.executing(), true);
    fixture.answer(fixture.events[0], { status: 'completed' });
    assert.deepEqual(await pending, { status: 'completed' });
    assert.equal(fixture.bridge.executing(), false);
  } finally {
    fixture.bridge.close();
  }
});

const request = (
  tool: AgentCapabilityRequest['tool'],
  args: AgentCapabilityRequest['arguments'],
): AgentCapabilityRequest => ({
  type: 'capability-request',
  tool,
  arguments: args,
  runId: 'run',
  sessionId: 'session',
  requestId: 'review',
  token: 'token',
});
test('live queries and events share the host; Review retains an immutable revision-bound command and Auto executes it', async () => {
  let revision = 1;
  const executed: unknown[] = [];
  const host: AgentCapabilities = {
    query: () => ({ revision }),
    execute: (name, input, options) => {
      executed.push({ name, input, options });
      return { applied: true };
    },
    observe: (after) => ({ cursor: revision, events: [{ seq: revision, type: 'changed', after }] }),
  };
  const observedRevision: { current?: string } = {};
  assert.deepEqual(
    await resolveAgentCapability(
      request('openpe_query', { name: 'project.snapshot' }),
      host,
      'auto',
      () => {},
      undefined,
      observedRevision,
    ),
    { revision: 1 },
  );
  revision++;
  assert.deepEqual(
    await resolveAgentCapability(
      request('openpe_query', { name: 'project.snapshot' }),
      host,
      'auto',
      () => {},
      undefined,
      observedRevision,
    ),
    { revision: 2 },
  );
  const observed = (await resolveAgentCapability(
    request('openpe_observe', { after: 1 }),
    host,
    'auto',
    () => {},
  )) as any;
  assert.equal(observed.cursor, 2);
  const args = { name: 'schematic.setValue', input: { id: 'R1', value: '10k' } };
  const reviews: AgentCommandReview[] = [];
  const result = (await resolveAgentCapability(
    request('openpe_execute', args),
    host,
    'review',
    (command) => reviews.push(command),
    undefined,
    observedRevision,
  )) as any;
  assert.equal(result.status, 'review-required');
  assert.equal(executed.length, 0);
  assert.equal(reviews[0].expectedRevision, '2');
  args.input.value = 'wrong';
  assert.deepEqual(reviews[0].input, { id: 'R1', value: '10k' });
  const control = new AbortController();
  await resolveAgentCapability(
    request('openpe_execute', { name: 'schematic.setValue', expectedRevision: '2' }),
    host,
    'auto',
    () => assert.fail(),
    control.signal,
  );
  assert.deepEqual(executed, [
    {
      name: 'schematic.setValue',
      input: undefined,
      options: { expectedRevision: '2', signal: control.signal },
    },
  ]);
  control.abort();
  await assert.rejects(
    resolveAgentCapability(
      request('openpe_execute', { name: 'schematic.setValue', expectedRevision: '2' }),
      host,
      'auto',
      () => {},
      control.signal,
    ),
  );
  assert.equal(executed.length, 1);
});

test('commands use the submission or explicitly observed revision and never silently refresh after a human edit', async () => {
  const project = createProject(switchingStageFixture());
  const part = project.schematic.parts.find((item) => item.ref === 'R1')!;
  const core = new ProjectCore(project);
  const host = createCapabilityHost();
  const dispose = registerProjectCapabilities(host, core);
  const snapshot = (await host.query('project.snapshot')) as { revision: string };
  const revision = { current: snapshot.revision };
  const args = {
    name: 'part.properties',
    input: { schematicId: project.schematic.id, partId: part.id, value: '47k' },
  };
  try {
    await host.execute('part.properties', { ...args.input, value: '22k' }, { actor: 'human' });
    await assert.rejects(
      resolveAgentCapability(
        request('openpe_execute', args),
        host,
        'auto',
        () => {},
        undefined,
        revision,
      ),
      /project changed/,
    );
    assert.equal(revision.current, snapshot.revision);
    const reviews: AgentCommandReview[] = [];
    await resolveAgentCapability(
      request('openpe_execute', args),
      host,
      'review',
      (command) => reviews.push(command),
      undefined,
      revision,
    );
    assert.equal(reviews[0].expectedRevision, snapshot.revision);
    await assert.rejects(
      host.execute(reviews[0].name, reviews[0].input, {
        expectedRevision: reviews[0].expectedRevision,
      }),
      /project changed/,
    );
    await assert.rejects(
      resolveAgentCapability(request('openpe_execute', args), host, 'auto', () => {}),
      /Query project.snapshot/,
    );
    await resolveAgentCapability(
      request('openpe_query', { name: 'project.snapshot' }),
      host,
      'auto',
      () => {},
      undefined,
      revision,
    );
    assert.notEqual(revision.current, snapshot.revision);
    await resolveAgentCapability(
      request('openpe_execute', args),
      host,
      'auto',
      () => {},
      undefined,
      revision,
    );
    assert.equal(
      core.getSnapshot().project!.schematic.parts.find((item) => item.id === part.id)!.value,
      '47k',
    );
  } finally {
    dispose();
    host.dispose();
  }
});

test('Agent connected component drag is discoverable, reviewable and uses the shared wire and undo transaction', async () => {
  const schematic = emptyCircuit();
  schematic.parts.push(
    createPart(schematic, 'R', 25.4, 25.4),
    createPart(schematic, 'C', 76.2, 25.4),
  );
  const [a, b] = schematic.parts.map(
    (part) => pinPositions(part, schematic.libraries[part.libId])[0],
  );
  schematic.wires.push({ id: uid(), a, b });
  const core = new ProjectCore(createProject(schematic));
  const host = createCapabilityHost();
  const dispose = registerProjectCapabilities(host, core);
  const revision: { current?: string } = {};
  const reviews: AgentCommandReview[] = [];
  const args = {
    name: 'schematic.drag',
    input: { schematicId: schematic.id, ids: [schematic.parts[0].id], delta: { x: 5.08, y: 0 } },
  };
  const query = (name: string) =>
    resolveAgentCapability(
      request('openpe_query', { name }),
      host,
      'auto',
      () => {},
      undefined,
      revision,
    );
  try {
    const catalog = (await query('capabilities.list')) as ReturnType<typeof host.catalog>;
    const capability = catalog.find((entry) => entry.id === 'schematic.drag');
    assert.equal(capability?.available, true);
    await query('project.snapshot');
    const initial = core.getSnapshot();
    const pending = await resolveAgentCapability(
      request('openpe_execute', args),
      host,
      'review',
      (command) => reviews.push(command),
      undefined,
      revision,
    );
    assert.equal((pending as { status: string }).status, 'review-required');
    assert.equal(core.getSnapshot(), initial);
    args.input.delta.x = 10.16;
    await host.execute(reviews[0].name, reviews[0].input, {
      expectedRevision: reviews[0].expectedRevision,
    });
    const reviewed = core.getSnapshot();
    assert.equal(reviewed.project!.schematic.parts[0].x, 30.48);
    assert.equal(reviewed.undoDepth, 1);
    await host.execute('history.undo');
    assert.equal(core.getSnapshot().project, initial.project);

    args.input.delta.x = 5.08;
    await query('project.snapshot');
    await resolveAgentCapability(
      request('openpe_execute', args),
      host,
      'auto',
      () => assert.fail(),
      undefined,
      revision,
    );
    const applied = core.getSnapshot();
    const circuit = applied.project!.schematic;
    const pin = pinPositions(circuit.parts[0], circuit.libraries[circuit.parts[0].libId])[0];
    assert.equal(applied.undoDepth, 1);
    assert.ok(circuit.wires.some((wire) => samePoint(wire.a, pin) || samePoint(wire.b, pin)));
    assert.ok(circuit.wires.some((wire) => samePoint(wire.a, b) || samePoint(wire.b, b)));
    assert.deepEqual(circuit, reviewed.project!.schematic);
    const control = new AbortController();
    control.abort();
    await assert.rejects(
      resolveAgentCapability(
        request('openpe_execute', args),
        host,
        'auto',
        () => {},
        control.signal,
        revision,
      ),
    );
    assert.equal(core.getSnapshot(), applied);
    await host.execute('history.undo');
    assert.equal(core.getSnapshot().project, initial.project);
  } finally {
    dispose();
    host.dispose();
  }
});

test('cancelled queries forward the turn signal and never update observed revisions after completion', async () => {
  let finish!: (result: unknown) => void;
  let querySignal: AbortSignal | undefined;
  const revision = { current: '1' };
  const host: AgentCapabilities = {
    query: (_name, _input, options) => {
      querySignal = options?.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    execute: () => assert.fail('A cancelled query must not execute a command.'),
    observe: () => ({}),
  };
  const control = new AbortController();
  const pending = resolveAgentCapability(
    request('openpe_query', { name: 'project.snapshot' }),
    host,
    'auto',
    () => {},
    control.signal,
    revision,
  );
  assert.equal(querySignal, control.signal);
  control.abort();
  finish({ revision: '2' });
  await assert.rejects(pending);
  assert.equal(revision.current, '1');
  await assert.rejects(
    resolveAgentCapability(
      request('openpe_execute', { name: 'part.properties', expectedRevision: '1' }),
      host,
      'review',
      () => assert.fail(),
      control.signal,
      revision,
    ),
  );
});

test('SSE permits bounded complete Source tool commands above 2 MB while regular text remains bounded', async () => {
  const source = 'x'.repeat(2_100_000);
  const parse = async (event: unknown) => {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    const events: unknown[] = [];
    await readChatEvents(
      new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 65536)
            controller.enqueue(bytes.slice(offset, offset + 65536));
          controller.close();
        },
      }),
      (value) => events.push(value),
    );
    return events;
  };
  assert.equal(
    (await parse(request('openpe_execute', { name: 'project.replace', input: { source } }))).length,
    1,
  );
  await assert.rejects(parse({ type: 'text', text: source }), /2 MB/);
});

test('Claude MCP adapter has a fixed ephemeral loopback target and exposes only the three capability tools', async () => {
  const env = {
    OPENPE_AGENT_BRIDGE_URL:
      'http://127.0.0.1:1234/api/agent-tools/11111111-1111-1111-1111-111111111111',
    OPENPE_AGENT_BRIDGE_TOKEN: 'a'.repeat(64),
  };
  for (const url of [
    'https://example.com/api/agent-tools/11111111-1111-1111-1111-111111111111',
    'http://127.0.0.1:1234/api/state',
    env.OPENPE_AGENT_BRIDGE_URL + '?path=private',
  ])
    assert.throws(() => agentMCPConnection({ ...env, OPENPE_AGENT_BRIDGE_URL: url }));
  const input = new PassThrough(),
    output = new PassThrough();
  const sent: any[] = [],
    received: any[] = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      received.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const adapter = startAgentMCP({
    input,
    output,
    env,
    request: async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      sent.push({ url, options });
      return new Response(JSON.stringify({ result: { revision: 5 } }));
    },
  });
  try {
    for (const message of [
      { id: 1, method: 'initialize', params: {} },
      { id: 2, method: 'tools/list' },
      {
        id: 3,
        method: 'tools/call',
        params: { name: 'openpe_query', arguments: { name: 'project.snapshot' } },
      },
      { id: 4, method: 'tools/call', params: { name: 'shell', arguments: {} } },
    ])
      input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    for (let i = 0; i < 100 && received.length < 4; i++) await pause(5);
    assert.equal(received.length, 4);
    assert.deepEqual(
      received.find((item) => item.id === 2).result.tools.map((tool: any) => tool.name),
      ['openpe_query', 'openpe_execute', 'openpe_observe'],
    );
    assert.equal(received.find((item) => item.id === 4).result.isError, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, env.OPENPE_AGENT_BRIDGE_URL);
    assert.equal(sent[0].options.redirect, 'error');
    assert.equal(sent[0].options.headers['X-OpenPE-Agent-Token'], env.OPENPE_AGENT_BRIDGE_TOKEN);
  } finally {
    adapter.close();
    input.end();
    output.end();
  }
});

test('authenticated HTTP relays capability results once and revokes CLI and renderer tokens at turn completion', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-tools-http-'));
  let endpoint = '',
    cliToken = '';
  const server = await startServer({
    dataDir,
    agentRunner: async (
      _provider: string,
      _request: unknown,
      _cwd: string,
      emit: (event: unknown) => void,
      _signal: AbortSignal,
      options: any,
    ) => {
      endpoint = options.capabilities.url;
      cliToken = options.capabilities.token;
      const result = await options.capabilities.call('openpe_query', { name: 'project.snapshot' });
      emit({ type: 'text', text: JSON.stringify(result) });
      return { outcome: 'completed' };
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  try {
    const response = await fetch(server.base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'codex',
        prompt: 'Inspect',
        history: [],
        context: {},
        sessionId: 'origin',
        capabilities: true,
      }),
    });
    const received: unknown[] = [];
    let event!: AgentCapabilityRequest;
    const stream = readChatEvents(response.body!, (value) => {
      received.push(value);
      if (value.type === 'capability-request') event = value;
    });
    for (let i = 0; i < 100 && !event; i++) await pause(5);
    assert.ok(event);
    const payload = {
      runId: event.runId,
      sessionId: event.sessionId,
      requestId: event.requestId,
      token: event.token,
      result: { revision: 8 },
    };
    const post = (body: unknown) =>
      fetch(server.base + '/api/chat/tool-result', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await post({ ...payload, sessionId: 'other' })).status, 409);
    assert.equal((await post(payload)).status, 200);
    await stream;
    assert.equal((await post(payload)).status, 409);
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-OpenPE-Agent-Token': cliToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'openpe_observe', arguments: {} }),
        })
      ).status,
      401,
    );
    assert.ok(received.some((value: any) => value.type === 'text' && value.text.includes('8')));
  } finally {
    server.close();
  }
});

test('Codex dynamic-tool protocol exposes shared runtime capabilities and rejects cross-thread calls', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-tools-protocol-'));
  const calls: unknown[] = [],
    events: any[] = [];
  const result = await runAgent(
    'codex',
    { prompt: 'Inspect Fixture', context: {}, history: [] },
    cwd,
    (event: unknown) => events.push(event),
    new AbortController().signal,
    {
      resolve: async () => ({
        file: process.execPath,
        args: [path.resolve('tests/fixtures/agent-capability-cli.mjs')],
        env: process.env,
      }),
      capabilities: {
        call: async (tool: string, args: unknown) => {
          calls.push({ tool, args });
          return { accepted: true };
        },
      },
    },
  );
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls, [
    { tool: 'openpe_query', args: { name: 'capabilities.list' } },
    {
      tool: 'openpe_execute',
      args: {
        name: 'schematic.setValue',
        input: { id: 'R1', value: '10k' },
        expectedRevision: '1',
      },
    },
    { tool: 'openpe_observe', args: { after: 0 } },
  ]);
  assert.ok(
    events.some(
      (event) => event.type === 'text-delta' && event.delta.includes('Runtime tools verified'),
    ),
  );
});

test('Claude launch uses the scoped stdio MCP helper through the authenticated renderer bridge', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-claude-tools-'));
  let revision = '8';
  const executed: unknown[] = [];
  const host: AgentCapabilities = {
    query: () => ({ revision }),
    execute: (name, input, options) => {
      executed.push({ name, input, expectedRevision: options?.expectedRevision });
      revision = '9';
      return { status: 'applied' };
    },
    observe: () => ({ cursor: Number(revision), events: [] }),
  };
  const server = await startServer({
    dataDir,
    agentRunner: (
      provider: Parameters<typeof runAgent>[0],
      request: any,
      cwd: string,
      emit: (event: unknown) => void,
      signal: AbortSignal,
      options: any,
    ) =>
      runAgent(provider, request, cwd, emit, signal, {
        ...options,
        resolve: async () => ({
          file: process.execPath,
          args: [path.resolve('tests/fixtures/agent-capability-claude-cli.mjs')],
          env: process.env,
        }),
      }),
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  try {
    const response = await fetch(server.base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'claude',
        prompt: 'Inspect Fixture',
        history: [],
        context: {},
        sessionId: 'claude-tools',
        capabilities: true,
      }),
    });
    const events: any[] = [],
      responses: Promise<unknown>[] = [];
    await readChatEvents(response.body!, (event) => {
      events.push(event);
      if (event.type !== 'capability-request') return;
      responses.push(
        (async () => {
          const result = await resolveAgentCapability(event, host, 'auto', () => assert.fail());
          const posted = await fetch(server.base + '/api/chat/tool-result', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              sessionId: event.sessionId,
              runId: event.runId,
              requestId: event.requestId,
              token: event.token,
              result,
            }),
          });
          assert.equal(posted.status, 200);
        })(),
      );
    });
    await Promise.all(responses);
    assert.equal(events.at(-1).outcome, 'completed');
    assert.equal(executed.length, 1);
    assert.equal((executed[0] as any).expectedRevision, '8');
    assert.ok(
      events.some(
        (event) =>
          event.type === 'text-delta' && event.delta.includes('Claude MCP runtime verified'),
      ),
    );
  } finally {
    server.close();
  }
});
