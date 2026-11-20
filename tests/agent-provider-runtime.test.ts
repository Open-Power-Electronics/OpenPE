import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectAgents, resolveAgent, runAgent } from '../server/agents.mjs';
import { listAgentModels } from '../server/agent-models.mjs';
import { createEventNormalizer } from '../server/agent-events.mjs';
import { piIsolationFlags } from '../server/agent-provider-runtime.mjs';
import { annotationFixture } from './fixtures/annotation';
import { waitForProcessStopped } from '../scripts/process-test-helpers.mjs';

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
  assert.deepEqual(calls, ['codex', 'claude', 'deepseek', 'pi']);
  assert.deepEqual(
    agents.map((agent: any) => agent.id),
    ['codex', 'claude', 'deepseek', 'pi', 'cursor'],
  );
  for (const agent of agents.filter((item: any) => item.id !== 'cursor')) {
    assert.equal(agent.available, false);
    assert.equal(agent.installed, false);
    assert.equal(agent.auth, 'unknown');
    assert.ok('error' in agent);
    assert.match(agent.error, /missing CLI/);
  }
  const missingCursor: any = agents.find((agent: any) => agent.id === 'cursor');
  assert.equal(missingCursor?.installed, true);
  assert.equal(missingCursor?.available, false);
  assert.match(missingCursor?.error, /API key/);
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
  assert.match(cursor.error, /API key/);
  assert.equal(cursor?.supportsCapabilities, undefined);
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
    events.some((event) => event.type === 'agent-info' && event.model === 'fixture/fixture-model'),
    true,
  );
});

test('Pi model discovery accepts a state-first response and marks non-text models unavailable', async () => {
  const result = await listAgentModels('pi', cwd, new AbortController().signal, {
    resolve: async () => launch(),
  });
  assert.equal(result.defaultModel, 'fixture/fixture-model');
  assert.deepEqual(
    result.models.map((item: any) => item.id),
    [
      'fixture/fixture-model',
      'fixture/ordinary-reasoner',
      'fixture/restricted-reasoner',
      'fixture/no-reasoning',
      'fixture/image-only',
    ],
  );
  assert.deepEqual(result.models[0].efforts, [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  assert.deepEqual(result.models[1].efforts, ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(result.models[2].efforts, ['high', 'max']);
  assert.deepEqual(result.models[3].efforts, ['off']);
  assert.equal(result.models[4].textInput, false);
});

test('Pi refuses to prompt when the selected provider-qualified model was not applied', async () => {
  const events: any[] = [];
  const result = await runAgent(
    'pi',
    { prompt: 'Fixture question', context: {}, model: 'fixture/ordinary-reasoner' },
    cwd,
    (event: any) => events.push(event),
    new AbortController().signal,
    { resolve: async () => launch() },
  );
  assert.equal(result.outcome, 'failed');
  assert.match(events.find((event) => event.type === 'error')?.text || '', /did not apply the selected model/);
});

test('Pi sends every native thinking level unchanged and rejects silent clamping before prompting', async () => {
  for (const effort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const events: any[] = [];
    const result = await runAgent(
      'pi',
      { prompt: 'Explain ripple', context: {}, effort, model: 'fixture/fixture-model' },
      cwd,
      (event) => events.push(event),
      new AbortController().signal,
      { resolve: async () => launch(`effort-${effort}`) },
    );
    assert.equal(result.outcome, 'completed', JSON.stringify(events));
    assert.equal(events.find((event) => event.type === 'agent-info')?.reasoningEffort, effort);
  }
  const events: any[] = [];
  const result = await runAgent(
    'pi',
    { prompt: 'Explain ripple', context: {}, effort: 'max', model: 'fixture/fixture-model' },
    cwd,
    (event) => events.push(event),
    new AbortController().signal,
    { resolve: async () => launch('clamped-effort') },
  );
  assert.equal(result.outcome, 'failed');
  assert.match(
    events.find((event) => event.type === 'error')?.text || '',
    /did not apply the configured reasoning effort/,
  );
});

test('Agent runtimes reject reasoning values from another provider before resolving its CLI', async () => {
  for (const [provider, effort] of [
    ['codex', 'off'],
    ['claude', 'ultra'],
    ['pi', 'none'],
    ['deepseek', 'medium'],
  ] as const) {
    await assert.rejects(
      runAgent(
        provider,
        { prompt: 'Test', context: {}, effort },
        cwd,
        () => {},
        new AbortController().signal,
        {
          resolve: async () => {
            throw new Error('Invalid reasoning effort must not resolve a CLI');
          },
        },
      ),
      /configured reasoning effort/,
    );
  }
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
    ['handshake-hang', /timed out/],
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
        timeoutMs: mode === 'handshake-hang' ? 1000 : 10000,
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

test(
  'Windows Codex lookup starts the npm executable directly even with a stale desktop PATH',
  { skip: process.platform !== 'win32' },
  async () => {
    assert.ok(process.env.APPDATA);
    const npmBin = path.join(process.env.APPDATA, 'npm');
    const shim = path.join(npmBin, 'codex.cmd');
    const modules = path.join(npmBin, 'node_modules');
    const packageRoot = path.join(modules, '@openai', 'codex');
    const launcher = path.join(packageRoot, 'bin', 'codex.js');
    const platformExe = path.join(
      '@openai',
      `codex-win32-${process.arch}`,
      'vendor',
      `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`,
      'bin',
      'codex.exe',
    );
    const nested = path.join(packageRoot, 'node_modules', platformExe);
    const hoisted = path.join(modules, platformExe);
    const olderCodex = 'C:\\Existing Codex\\bin\\codex.exe';
    const lookup = async () => ({ stdout: `${olderCodex}\r\n` });

    const updated = await resolveAgent('codex', {
      exec: lookup,
      exists: (file: string) => [shim, launcher, nested, hoisted, olderCodex].includes(file),
    });
    assert.equal(updated.file, nested);
    assert.deepEqual(updated.args, []);
    assert.equal(updated.env.CODEX_MANAGED_PACKAGE_ROOT, packageRoot);
    assert.equal(updated.env.CODEX_MANAGED_BY_NPM, '1');

    const withHoistedBinary = await resolveAgent('codex', {
      exec: lookup,
      exists: (file: string) => [shim, launcher, hoisted, olderCodex].includes(file),
    });
    assert.equal(withHoistedBinary.file, hoisted);

    const incomplete = await resolveAgent('codex', {
      exec: lookup,
      exists: (file: string) => [shim, launcher, olderCodex].includes(file),
    });
    assert.equal(incomplete.file, olderCodex);
    assert.deepEqual(incomplete.args, []);
  },
);

test('POSIX CLI lookup uses fixed user and system bins', { skip: process.platform === 'win32' }, async () => {
  const home = '/fixture-home';
  const codex = path.join(home, '.local', 'bin', 'codex');
  const launch = await resolveAgent('codex', {
    home,
    exec: async () => {
      throw new Error('not on PATH');
    },
    exists: (file: string) => file === codex,
  });
  assert.equal(launch.file, codex);
  const pi = path.join(home, '.pi', 'agent', 'bin', 'pi');
  const piLaunch = await resolveAgent('pi', {
    home,
    exec: async () => {
      throw new Error('not on PATH');
    },
    exists: (file: string) => file === pi,
  });
  assert.equal(piLaunch.file, pi);
  await assert.rejects(resolveAgent('cursor', { home }), /no CLI launcher/);
});

test('POSIX cleanup signals the detached process group', { skip: process.platform === 'win32' }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-group-'));
  const script = path.join(cwd, 'group.mjs');
  await writeFile(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync('grandchild.pid', String(grand.pid));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  let pid = 0;
  try {
    const result = await runAgent(
      'codex',
      { prompt: 'group', context: {} },
      cwd,
      () => {},
      new AbortController().signal,
      {
        resolve: async () => ({ file: process.execPath, args: [script], env: process.env }),
        timeoutMs: 1500,
      },
    );
    assert.equal(result.outcome, 'failed');
    pid = Number(await readFile(path.join(cwd, 'grandchild.pid'), 'utf8'));
    await waitForProcessStopped(pid);
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The group signal already stopped it.
      }
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
