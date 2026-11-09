import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { runAgent } from '../server/agents.mjs';
import { runPiAgent } from '../server/agent-pi.mjs';
import { runACPAgent } from '../server/agent-acp.mjs';

for (const provider of ['codex', 'claude', 'pi', 'deepseek'] as const)
  for (const outcome of ['completed', 'cancelled'] as const)
    test(`${provider} can ${outcome === 'completed' ? 'complete' : 'stop'} after silent and streaming work beyond five minutes`, async (t) => {
      const child = new childProcess.ChildProcess();
      const stdin = new PassThrough(),
        stdout = new PassThrough(),
        stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        Object.defineProperty(child, 'exitCode', { value: 0 });
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      };
      stdin.on('finish', () => queueMicrotask(close));
      const records: any[] = [],
        events: any[] = [];
      stdin.on('data', (bytes) => {
        const record = JSON.parse(bytes.toString());
        records.push(record);
        if (record.method === 'session/close')
          queueMicrotask(() => stdout.write(JSON.stringify({ id: record.id, result: {} }) + '\n'));
      });
      const spawn = t.mock.method(childProcess, 'spawn', (() => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }) as typeof childProcess.spawn);
      t.mock.method(child, 'kill', () => {
        queueMicrotask(close);
        return true;
      });
      syncBuiltinESMExports();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const control = new AbortController();
      const launch = { file: 'isolated-fixture', args: [], env: { NODE_ENV: 'test' as const } };
      const request = { prompt: 'Fixture', context: { title: 'Fixture' }, history: [] };
      const emit = (event: any) => events.push(event);
      let settled = false;
      const pending = (
        provider === 'pi'
          ? runPiAgent(request, 'Fixture', launch, 'fixture', emit, control.signal)
          : provider === 'deepseek'
            ? runACPAgent(provider, request, emit, control.signal, { launch })
            : runAgent(provider, request, 'fixture', emit, control.signal, {
                resolve: async () => launch,
              })
      ).finally(() => {
        settled = true;
      });
      const receive = (event: unknown) => stdout.write(JSON.stringify(event) + '\n');
      const sent = async (method: string) => {
        const deadline = Date.now() + 10000;
        while (true) {
          const record = records.find((item) => item.method === method || item.type === method);
          if (record) return record;
          assert.ok(
            !settled && Date.now() < deadline,
            `Expected ${method}; ${JSON.stringify(events)}`,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      };
      try {
        if (provider === 'codex') {
          receive({ id: (await sent('initialize')).id, result: {} });
          receive({ id: (await sent('thread/start')).id, result: { thread: { id: 'thread' } } });
          receive({ id: (await sent('turn/start')).id, result: { turn: { id: 'turn' } } });
        } else if (provider === 'claude') {
          await sent('user');
          receive({ type: 'system', subtype: 'init', model: 'fixture' });
        } else if (provider === 'pi') {
          const state = await sent('get_state');
          receive({
            type: 'response',
            id: state.id,
            command: 'get_state',
            success: true,
            data: {},
          });
          await sent('prompt');
        } else {
          receive({ id: (await sent('initialize')).id, result: { protocolVersion: 1 } });
          receive({ id: (await sent('session/new')).id, result: { sessionId: 'session' } });
          await sent('session/prompt');
        }
        t.mock.timers.tick(300001);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          settled,
          false,
          'Silence after initialization must have no whole-turn deadline.',
        );
        if (provider === 'codex')
          receive({
            method: 'item/agentMessage/delta',
            params: { itemId: 'message', delta: 'Still working.' },
          });
        else if (provider === 'claude')
          receive({
            type: 'assistant',
            message: { id: 'message', content: [{ type: 'text', text: 'Still working.' }] },
          });
        else if (provider === 'pi')
          receive({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Still working.' },
          });
        else
          receive({
            method: 'session/update',
            params: {
              sessionId: 'session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Still working.' },
              },
            },
          });
        t.mock.timers.tick(600000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'Streaming must not retain a hidden deadline.');
        assert.ok(
          events.some((event) => event.type === 'text-delta' || event.type === 'text-replace'),
        );
        assert.equal(
          events.some((event) => event.type === 'error'),
          false,
        );
        if (outcome === 'cancelled') control.abort();
        else if (provider === 'codex')
          receive({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        else if (provider === 'claude')
          receive({ type: 'result', subtype: 'success', result: 'Still working.' });
        else if (provider === 'pi') receive({ type: 'agent_settled', aborted: false });
        else receive({ id: (await sent('session/prompt')).id, result: { stopReason: 'end_turn' } });
        assert.equal((await pending).outcome, outcome);
      } finally {
        control.abort();
        await pending.catch(() => {});
        close();
        for (const stream of [stdin, stdout, stderr]) stream.destroy();
        t.mock.timers.reset();
        spawn.mock.restore();
        syncBuiltinESMExports();
      }
    });
