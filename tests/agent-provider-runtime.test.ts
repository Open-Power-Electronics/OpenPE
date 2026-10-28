import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectAgents, resolveAgent, runAgent } from '../server/agents.mjs';
import { listAgentModels } from '../server/agent-models.mjs';
import { createEventNormalizer } from '../server/agent-events.mjs';
import { piIsolationFlags } from '../server/agent-provider-runtime.mjs';
import { annotationFixture } from './fixtures/annotation';

const cwd = process.cwd();
const fixture = path.join(cwd, 'tests', 'fixtures', 'agent-pi-cli.mjs');
const launch = (mode = 'normal') => ({
  file: process.execPath,
  args: [fixture, mode],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

test('Agent detection retains all supported identities when no CLI is installed', async () => {
  const calls: string[] = [];
  const agents = await detectAgents({
    resolve: async (id: string) => {
      calls.push(id);
      throw new Error('Fixture missing CLI');
    },
    exec: async () => {
      throw new Error('Missing agents must not execute');
    },
  });
  assert.deepEqual(calls, ['codex', 'claude', 'deepseek', 'pi', 'cursor']);
  assert.deepEqual(
    agents.map((agent: any) => agent.id),
    calls,
  );
  for (const agent of agents) {
    assert.equal(agent.available, false);
    assert.equal(agent.installed, false);
    assert.equal(agent.auth, 'unknown');
    assert.ok('error' in agent);
    assert.match(agent.error, /missing CLI/);
  }
});

test('Detection distinguishes missing, incompatible and safely runnable agents without inference', async () => {
  const operations: string[] = [];
  const agents = await detectAgents({
    resolve: async (id: string) => ({ file: id, args: [], env: {} }),
    exec: async (file: string, args: string[]) => {
      operations.push(`${file} ${args.join(' ')}`);
      return {
        stdout: args.includes('--help')
          ? `${piIsolationFlags.join(' ')} --effort --patch --profile`
          : `${file} fixture version`,
      };
    },
  });
  for (const id of ['codex', 'claude', 'pi']) {
    const agent = agents.find((item: any) => item.id === id);
    assert.equal(agent?.available, true);
    assert.equal(agent?.installed, true);
    assert.equal(agent?.supportsEffort, true);
    assert.equal(agent?.supportsCapabilities, id !== 'pi');
  }
  for (const id of ['deepseek']) {
    const agent = agents.find((item: any) => item.id === id);
    assert.equal(agent?.available, true);
    assert.equal(agent?.installed, true);
    assert.equal(agent?.supportsCapabilities, false);
    assert.equal(agent?.supportsEffort, false);
  }
  const cursor = agents.find((item: any) => item.id === 'cursor');
  assert.equal(cursor?.installed, true);
  assert.equal(cursor?.available, false);
  assert.ok(cursor && 'error' in cursor);
  assert.match(cursor.error, /tool-isolated/);
  assert.ok(operations.every((operation) => / --(?:help|version)$/.test(operation)));
  const incompatible = await detectAgents({
    resolve: async () => launch('incompatible'),
    exec: async () => ({ stdout: '--mode --no-tools' }),
  });
  const incompatiblePi = incompatible.find((item: any) => item.id === 'pi');
  assert.ok(incompatiblePi && 'error' in incompatiblePi);
  assert.match(incompatiblePi.error, /Update Pi/);
});

test('Unknown providers cannot fall through to another agent protocol', async () => {
  const control = new AbortController();
  const resolve = async () => {
    throw new Error('Unknown providers must not spawn');
  };
  await assert.rejects(resolveAgent('unknown'), /Unknown agent/);
  await assert.rejects(
    runAgent(
      'unknown' as Parameters<typeof runAgent>[0],
      { prompt: 'test', context: {} },
      cwd,
      () => {},
      control.signal,
      { resolve },
    ),
    /Unknown agent/,
  );
  await assert.rejects(
    listAgentModels('unknown', cwd, control.signal, { resolve }),
    /Unknown agent/,
  );
  assert.throws(() => createEventNormalizer('unknown'), /Unknown agent event protocol/);
});

test('Pi uses isolated RPC with context-only instructions, reconciles snapshots and waits for settlement', async () => {
  const events: any[] = [];
  const result = await runAgent(
    'pi',
    { prompt: 'Explain ripple', context: {}, effort: 'high', model: 'fixture/fixture-model' },
    cwd,
    (event: any) => events.push(event),
    new AbortController().signal,
    {
      resolve: async () => launch(),
      capabilities: {
        call: async () => {
          throw new Error('Pi cannot invoke OpenPE tools');
        },
        token: 'private-bridge-token',
      },
    },
  );
  assert.equal(result.outcome, 'completed');
  assert.equal(
    events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join(''),
    '电感 ripple.',
  );
  assert.equal(events.filter((event) => event.type === 'text-replace').length, 0);
  assert.equal(
    events.some((event) => event.type === 'agent-info' && event.model === 'fixture-model'),
    true,
  );
});

test('Pi model discovery accepts a state-first response and filters non-text or invalid catalog entries', async () => {
  const result = await listAgentModels('pi', cwd, new AbortController().signal, {
    resolve: async () => launch(),
  });
  assert.equal(result.defaultModel, 'fixture/fixture-model');
  assert.deepEqual(
    result.models.map((item: any) => item.id),
    ['fixture/fixture-model'],
  );
  assert.deepEqual(result.models[0].efforts, ['low', 'medium', 'high']);
});

test('Pi receives validated annotation images directly in its prompt without temporary files', async () => {
  const result = await runAgent(
    'pi',
    { prompt: 'Inspect annotation', context: {}, annotations: [annotationFixture()] },
    cwd,
    () => {},
    new AbortController().signal,
    { resolve: async () => launch('images') },
  );
  assert.equal(result.outcome, 'completed');
});

test('Pi fails clearly on incompatible versions, forbidden actions, model failure, cancellation and timeout', async () => {
  const request = { prompt: 'Explain ripple', context: {} };
  await assert.rejects(
    runAgent('pi', request, cwd, () => {}, new AbortController().signal, {
      resolve: async () => launch('incompatible'),
    }),
    /Update Pi/,
  );
  for (const [mode, expected] of [
    ['tool', /attempted a tool/],
    ['error', /Fixture model failure/],
    ['hang', /timed out/],
  ] as const) {
    const events: any[] = [];
    const result = await runAgent(
      'pi',
      request,
      cwd,
      (event: any) => events.push(event),
      new AbortController().signal,
      {
        resolve: async () => launch(mode),
        timeoutMs: mode === 'hang' ? 300 : 10000,
      },
    );
    assert.equal(result.outcome, 'failed');
    assert.match(events.find((event) => event.type === 'error')?.text || '', expected);
  }
  const control = new AbortController();
  const pending = runAgent(
    'pi',
    request,
    cwd,
    () => {
      control.abort();
    },
    control.signal,
    { resolve: async () => launch('hang') },
  );
  assert.equal((await pending).outcome, 'cancelled');
});
