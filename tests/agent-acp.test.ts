import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runACPAgent, prepareACPWorkspace } from '../server/agent-acp.mjs';
import { apply as installDeepSeekBoundary } from '../server/deepseek-tool-boundary.mjs';
import { runAgent } from '../server/agents.mjs';
import { listAgentModels } from '../server/agent-models.mjs';
import { annotationFixture as annotation } from './fixtures/annotation';

const providers = ['deepseek'] as const;
type ACPProvider = (typeof providers)[number];
const request = { prompt: 'Fixture question', context: { title: 'Fixture' }, history: [] };
const png = annotation().image.dataUrl.split(',')[1];
async function fixture(t: TestContext, provider: ACPProvider, mode: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-acp-test-'));
  const log = path.join(directory, 'transcript.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launch = {
    file: process.execPath,
    args: [path.resolve('tests/fixtures/agent-acp-cli.mjs'), provider, mode],
    env: { ...process.env, OPENPE_ACP_FIXTURE_LOG: log },
  };
  const records = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const assertCleaned = async () => {
    const startup = (await records()).find((entry) => entry.type === 'launch');
    assert.ok(startup.cwd !== directory);
    assert.match(path.basename(startup.cwd), /^openpe-agent-/);
    await assert.rejects(stat(startup.cwd), { code: 'ENOENT' });
    assert.throws(() => process.kill(startup.pid, 0), 'The synthetic ACP process must be stopped.');
  };
  return { directory, launch, records, assertCleaned };
}

test('DeepSeek installs a fail-closed unconditional guard before publishing readiness', () => {
  let guard: ((...args: unknown[]) => unknown) | undefined;
  let ready = false;
  installDeepSeekBoundary({
    tools: {
      guard: (handler: typeof guard) => {
        guard = handler;
      },
    },
    provide: (name: string, value: unknown) => {
      assert.equal(typeof guard, 'function');
      assert.equal(name, 'openpeToolBoundary');
      assert.equal(value, true);
      ready = true;
    },
  });
  assert.equal(ready, true);
  for (const input of [undefined, {}, { name: 'shell' }, { name: 'unregistered-future-tool' }]) {
    assert.equal(typeof guard!(input), 'string');
    assert.ok(String(guard!(input)).includes('disabled'));
  }
  let providedWithoutGuard = false;
  assert.throws(
    () =>
      installDeepSeekBoundary({
        tools: {},
        provide: () => {
          providedWithoutGuard = true;
        },
      }),
    /cannot enforce/,
  );
  assert.equal(providedWithoutGuard, false);
});

test('DeepSeek ACP private workspaces contain the tool guard and readiness patch', async () => {
  for (const provider of providers) {
    const workspace = await prepareACPWorkspace(provider);
    try {
      assert.match(path.basename(workspace.directory), /^openpe-agent-/);
      const patch = JSON.parse(await readFile(workspace.args.at(-1)!, 'utf8'));
      assert.deepEqual(patch.find((entry: { id: string }) => entry.id === 'acp').inject, [
        'acpAppStartup',
        'openpeToolBoundary',
      ]);
      assert.equal(
        await readFile(path.join(workspace.directory, 'boundary.mjs'), 'utf8'),
        await readFile('server/deepseek-tool-boundary.mjs', 'utf8'),
      );
    } finally {
      await rm(workspace.directory, { recursive: true, force: true });
    }
  }
  await assert.rejects(prepareACPWorkspace('claude'), /Unknown ACP/);
  await assert.rejects(prepareACPWorkspace('cursor'), /Unknown ACP/);
});

test('ACP model discovery reads provider session catalogs without submitting a prompt', async (t) => {
  for (const provider of providers) {
    const mock = await fixture(t, provider, 'catalog');
    const result = await listAgentModels(provider, mock.directory, new AbortController().signal, {
      resolve: async () => mock.launch,
    });
    assert.deepEqual(
      result.models.map(({ id, label }: { id: string; label: string }) => ({ id, label })),
      [
        { id: 'fixture-first', label: 'First' },
        { id: 'fixture-second', label: 'Second' },
      ],
    );
    assert.equal(result.defaultModel, 'fixture-first');
    const methods = (await mock.records())
      .filter((entry) => entry.type === 'request')
      .map((entry) => entry.method);
    assert.ok(methods.includes('session/new'));
    assert.equal(methods.includes('session/prompt'), false);
    assert.equal(methods.includes('thread/start'), false);
    await mock.assertCleaned();
  }
});

test('ACP selected-model and image requests use explicit protocols without Claude/Codex fallback', async (t) => {
  for (const provider of providers) {
    const mock = await fixture(t, provider, 'images');
    const events: any[] = [];
    const result = await runAgent(
      provider,
      { ...request, model: 'fixture-second', annotations: [annotation()] },
      mock.directory,
      (event: any) => events.push(event),
      new AbortController().signal,
      {
        resolve: async () => mock.launch,
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
    assert.equal(
      events.some((event) => event.type === 'capability-request'),
      false,
    );
    assert.ok(
      events.some((event) => event.type === 'agent-info' && event.model === 'fixture-second'),
    );
    const records = await mock.records();
    const methods = records
      .filter((entry) => entry.type === 'request')
      .map((entry) => entry.method);
    assert.ok(methods.indexOf('session/new') < methods.indexOf('session/prompt'));
    assert.ok(methods.indexOf('session/set_config_option') < methods.indexOf('session/prompt'));
    const prompt = records.find((entry) => entry.method === 'session/prompt').params.prompt;
    assert.match(prompt[0].text, /Use only the supplied context and history/);
    assert.doesNotMatch(prompt[0].text, /openpe_(query|execute|observe)/);
    assert.equal(prompt[1].data, png);
    await mock.assertCleaned();
  }
});

test('ACP client filesystem, terminal and permission requests always receive denials', async (t) => {
  for (const provider of providers) {
    const mock = await fixture(t, provider, 'tools');
    const events: any[] = [];
    const result = await runACPAgent(
      provider,
      request,
      (event: any) => events.push(event),
      new AbortController().signal,
      { launch: mock.launch, timeoutMs: 2000 },
    );
    assert.equal(result.outcome, 'completed');
    assert.equal(
      (await mock.records()).filter((entry) => entry.type === 'tool-rejected').length,
      5,
    );
    assert.equal(
      events.some((event) => event.type === 'capability-request'),
      false,
    );
    await mock.assertCleaned();
  }
});

test('ACP unsupported model, effort and images fail before a prompt is sent', async (t) => {
  for (const provider of providers)
    for (const [mode, change, message] of [
      ['catalog', { model: 'not-advertised' }, /not advertised/],
      ['catalog', { effort: 'high' }, /configured reasoning effort/],
      ['no-images', { annotations: [annotation()] }, /does not advertise image support/],
    ] as const) {
      const mock = await fixture(t, provider, mode);
      await assert.rejects(
        runACPAgent(provider, { ...request, ...change }, () => {}, new AbortController().signal, {
          launch: mock.launch,
          timeoutMs: 2000,
        }),
        message,
      );
      assert.equal(
        (await mock.records()).some((entry) => entry.method === 'session/prompt'),
        false,
      );
      await mock.assertCleaned();
    }
});

test('ACP failed, incomplete, empty and invalid protocol responses never complete successfully', async (t) => {
  for (const provider of providers)
    for (const [mode, error] of [
      ['error', /Fixture ACP failure/],
      ['stopped', /stopped before completing/],
      ['empty', /no response content/],
      ['invalid-json', /invalid ACP response/],
      ['bad-version', /ACP version 1/],
      ['handshake-hang', /did not answer initialize/],
    ] as const) {
      const mock = await fixture(t, provider, mode);
      await assert.rejects(
        runACPAgent(provider, request, () => {}, new AbortController().signal, {
          launch: mock.launch,
          timeoutMs: 2000,
        }),
        error,
      );
      await mock.assertCleaned();
    }
});

test('ACP cancellation retains received text and cleans the private process and workspace', async (t) => {
  for (const provider of providers) {
    const mock = await fixture(t, provider, 'cancel');
    const controller = new AbortController();
    const events: any[] = [];
    const result = await runACPAgent(
      provider,
      request,
      (event: any) => {
        events.push(event);
        if (event.type === 'text-delta') controller.abort();
      },
      controller.signal,
      { launch: mock.launch, timeoutMs: 2000 },
    );
    assert.equal(result.outcome, 'cancelled');
    assert.deepEqual(
      events.filter((event) => event.type === 'text-delta').map((event) => event.delta),
      ['电感'],
    );
    await mock.assertCleaned();
  }
});

test('Cursor run and model discovery fail closed before resolving or launching its CLI', async () => {
  let resolutions = 0;
  const resolve = async () => {
    resolutions++;
    throw new Error('The Cursor resolver must not run.');
  };
  await assert.rejects(
    runAgent('cursor', request, '.', () => {}, new AbortController().signal, {
      resolve,
    }),
    /tool-isolated/,
  );
  await assert.rejects(
    listAgentModels('cursor', '.', new AbortController().signal, {
      resolve,
    }),
    /tool-isolated/,
  );
  assert.equal(resolutions, 0);
});
