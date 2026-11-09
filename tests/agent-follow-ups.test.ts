import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentInputBridge } from '../server/agent-input.mjs';
import { runAgent } from '../server/agents.mjs';
import { startServer } from '../server/index.mjs';
import { readChatEvents } from '../lib/chat-stream';
import { validateAgentSettings } from '../lib/agent-settings';

const origin = 'http://localhost:3000';
function inputBridge() {
  const control = new AbortController();
  const events: any[] = [];
  const bridge = createAgentInputBridge({
    sessionId: 'session',
    origin,
    signal: control.signal,
    emit: (e: any) => events.push(e),
  });
  const body = () => ({
    ...events.find((e) => e.type === 'input-ready'),
    requestId: 'request',
    prompt: 'Use 24 V.',
  });
  const request = () => {
    const { type: _, ...request } = body();
    return request;
  };
  return { bridge, control, events, request };
}

test('steering binds origin/run/session/token and deduplicates delivery, including concurrent retries', async () => {
  const { bridge, control, events, request } = inputBridge();
  let calls = 0;
  let accept!: () => void;
  bridge.register(
    (_prompt: string, acknowledge: () => void) =>
      new Promise<void>((resolve) => {
        calls++;
        accept = () => {
          acknowledge();
          resolve();
        };
      }),
  );
  for (const change of [
    { runId: 'foreign' },
    { sessionId: 'other' },
    { token: 'invalid' },
    { prompt: '' },
    { prompt: 'x'.repeat(16001) },
    { extra: true },
  ])
    await assert.rejects(bridge.submit({ ...request(), ...change }, origin));
  await assert.rejects(bridge.submit(request(), 'http://foreign'));
  const first = bridge.submit(request(), origin);
  const retry = bridge.submit(request(), origin);
  await Promise.resolve();
  assert.equal(calls, 1);
  accept();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await retry, { ok: true });
  assert.equal(events.filter((e) => e.type === 'input-accepted').length, 1);
  await assert.rejects(bridge.submit({ ...request(), prompt: 'Different' }, origin));
  control.abort();
  await assert.rejects(bridge.submit(request(), origin));
});

test('steering cannot acknowledge late delivery and is bounded to 32 requests per run', async () => {
  const { bridge, control, events, request } = inputBridge();
  bridge.register((_text: string, accepted: () => void) => accepted());
  for (let i = 0; i < 32; i++)
    await bridge.submit({ ...request(), requestId: 'input-' + i }, origin);
  await assert.rejects(bridge.submit({ ...request(), requestId: 'overflow' }, origin), /limit/);
  control.abort();
  const late = inputBridge();
  let ack!: () => void;
  late.bridge.register((_text: string, accepted: () => void) => {
    ack = accepted;
    return new Promise<void>(() => {});
  });
  void late.bridge.submit(late.request(), origin);
  await Promise.resolve();
  late.control.abort();
  ack();
  assert.equal(
    late.events.some((e) => e.type === 'input-accepted'),
    false,
  );
  assert.equal(events.filter((e) => e.type === 'input-accepted').length, 32);
});

test('Codex steers the active native turn without restarting, and rejection does not fail the original response', async () => {
  for (const mode of ['codex-steer', 'codex-steer-reject', 'codex-steer-close']) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-steer-'));
    const { bridge, control, events, request } = inputBridge();
    const result = runAgent(
      'codex',
      {
        sessionId: 'session',
        prompt: 'Fixture',
        context: { title: 'Fixture' },
        history: [],
        model: 'fixture-model',
        effort: 'high',
      },
      cwd,
      (event: any) => events.push(event),
      control.signal,
      {
        input: bridge,
        resolve: async () => ({
          file: process.execPath,
          args: [path.resolve('tests/fixtures/agent-cli.mjs'), mode],
          env: process.env,
        }),
      },
    );
    const deadline = Date.now() + 10000;
    while (!events.some((e) => e.type === 'input-ready')) {
      assert.ok(Date.now() < deadline, 'Native turn must become ready.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const delivery = bridge.submit({ ...request(), prompt: 'Use 24 V. $(literal)' }, origin);
    if (mode === 'codex-steer') assert.deepEqual(await delivery, { ok: true });
    else if (mode.endsWith('reject'))
      await assert.rejects(delivery, {
        message: 'Steering rejected',
        code: 'OPENPE_STEER_REJECTED',
      });
    else await assert.rejects(delivery, /turn has ended/);
    assert.equal((await result).outcome, 'completed');
    assert.equal(
      events.filter((e) => e.type === 'input-accepted').length,
      mode === 'codex-steer' ? 1 : 0,
    );
    if (mode === 'codex-steer')
      assert.ok(
        events.findIndex((e) => e.type === 'input-accepted') <
          events.findIndex((e) => e.type === 'text-delta' && e.delta.includes('24 V')),
      );
    control.abort();
  }
});

test('authenticated steering route accepts only its originating live stream and never grants tools', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-input-route-'));
  let finish!: () => void;
  let calls = 0;
  const service = await startServer({
    dataDir,
    agentRunner: async (
      _provider: any,
      _request: any,
      _cwd: any,
      emit: any,
      signal: AbortSignal,
      options: any,
    ) => {
      options.input.register((_text: string, accepted: () => void) => {
        calls++;
        accepted();
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      emit({ type: 'text', text: 'Completed' });
      return { outcome: 'completed' };
    },
  });
  const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
  const control = new AbortController();
  try {
    const response = await fetch(service.base + '/api/chat', {
      method: 'POST',
      headers,
      signal: control.signal,
      body: JSON.stringify({
        provider: 'codex',
        sessionId: 'session',
        prompt: 'Fixture',
        context: { title: 'Fixture' },
        history: [],
      }),
    });
    let ready!: any;
    const streamed = readChatEvents(response.body!, (event) => {
      if (event.type === 'input-ready') ready = event;
    });
    while (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
    const { type: _, ...target } = ready;
    const body = JSON.stringify({ ...target, requestId: 'request', prompt: 'Use 24 V.' });
    assert.equal(
      (
        await fetch(service.base + '/api/chat/steer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      ).status,
      401,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await fetch(service.base + '/api/chat/steer', { method: 'POST', headers, body })).status,
        200,
      );
    assert.equal(calls, 1);
    finish();
    await streamed;
    assert.equal(
      (await fetch(service.base + '/api/chat/steer', { method: 'POST', headers, body })).status,
      409,
    );
  } finally {
    control.abort();
    service.close();
  }
});

test('Agent behavior settings persist separately from recovery and reject unsupported or damaged data', async () => {
  for (const value of [
    null,
    {},
    { followUpMode: 'interrupt' },
    { followUpMode: { toString: () => 'queue' } },
    { followUpMode: 'queue', extra: true },
  ])
    assert.throws(() => validateAgentSettings(value));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-agent-settings-'));
  const service = await startServer({ dataDir });
  const headers = { 'X-OpenPE-Token': service.token, 'Content-Type': 'application/json' };
  const url = service.base + '/api/agent-settings';
  try {
    assert.deepEqual(await (await fetch(url, { headers })).json(), { followUpMode: 'queue' });
    assert.equal(
      (await fetch(url, { method: 'POST', headers, body: '{"followUpMode":"steer"}' })).status,
      200,
    );
    assert.deepEqual(await (await fetch(url, { headers })).json(), { followUpMode: 'steer' });
    assert.equal(
      (await fetch(url, { method: 'POST', headers, body: '{"followUpMode":"stop"}' })).status,
      400,
    );
    const file = path.join(dataDir, 'agent-settings-v1.json');
    await writeFile(file, 'damaged');
    assert.equal((await fetch(url, { headers })).status, 500);
    assert.equal(await readFile(file, 'utf8'), 'damaged');
  } finally {
    service.close();
  }
});
