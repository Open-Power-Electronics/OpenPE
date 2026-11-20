import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.mjs';
import { detectAgents, resolveAgent, runAgent, runRawAgent } from '../server/agents.mjs';
import { listAgentModels } from '../server/agent-models.mjs';
import {
  assertCursorSdkTools,
  cursorCatalogEntry,
  cursorCheckRequest,
  cursorModelSelection,
  proveCursorMcpTools,
  validCursorRequestParameters,
} from '../server/agent-cursor.mjs';
import { isCursorBooleanParameter, readCursorUnavailableModels } from '../lib/cursor-catalog';
import { startAgentMCP } from '../server/agent-mcp.mjs';

const apiKey = 'cursor_test_key_value_0001';
const capabilityToken = 'a'.repeat(64);
const questionToken = 'b'.repeat(64);
const capabilityUrl = 'http://127.0.0.1:9/api/agent-tools/11111111-1111-4111-8111-111111111111';
const questionUrl = 'http://127.0.0.1:9/api/agent-questions/22222222-2222-4222-8222-222222222222';
const allowedProtoTools = [
  'get_mcp_tools_tool_call',
  'list_mcp_resources_tool_call',
  'mcp_auth_tool_call',
  'mcp_tool_call',
  'read_mcp_resource_tool_call',
];
const disallowedProtoTools = [
  'list_mcp_resources_tool_call',
  'mcp_auth_tool_call',
  'read_mcp_resource_tool_call',
  'shell_tool_call',
  'task_tool_call',
];
function cursorVariants(
  parameters: { id: string; values: string[] }[],
  defaults: Record<string, string>,
  extra: { id: string; value: string }[] = [],
) {
  const lists = parameters.map((parameter) =>
    parameter.values.map((value) => ({ id: parameter.id, value })),
  );
  const combos = lists.reduce<{ id: string; value: string }[][]>(
    (sets, list) => sets.flatMap((set) => list.map((item) => [...set, item])),
    [[]],
  );
  return combos.map((params) => ({
    params: [...extra, ...params],
    ...(params.every((param) => defaults[param.id] === param.value) ? { isDefault: true } : {}),
  }));
}

const grokParameters = [
  {
    id: 'context',
    displayName: 'Context',
    values: [
      { value: '256k', displayName: '256K' },
      { value: '500k', displayName: '500K' },
    ],
  },
  {
    id: 'reasoning_effort',
    displayName: 'Effort',
    values: [
      { value: 'low', displayName: 'Low' },
      { value: 'high', displayName: 'High' },
    ],
  },
  {
    id: 'fast',
    displayName: 'Fast',
    values: [{ value: 'false' }, { value: 'true', displayName: 'Fast\u200b\u200b' }],
  },
];
const grokDefaults = { context: '500k', reasoning_effort: 'high', fast: 'true' };
const catalog = [
  {
    id: 'grok-4.7',
    displayName: 'Grok 4.7',
    description: 'Owner model',
    parameters: grokParameters,
    variants: cursorVariants(
      [
        { id: 'context', values: ['256k', '500k'] },
        { id: 'reasoning_effort', values: ['low', 'high'] },
        { id: 'fast', values: ['false', 'true'] },
      ],
      grokDefaults,
    ).filter((variant) => {
      const value = (id: string) => variant.params.find((param) => param.id === id)?.value;
      return !(
        value('context') === '256k' &&
        value('reasoning_effort') === 'low' &&
        value('fast') === 'true'
      );
    }),
  },
  {
    id: 'composer-2.5',
    displayName: 'Composer',
    parameters: [
      {
        id: 'fast',
        displayName: 'Fast',
        values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
      },
    ],
    variants: cursorVariants([{ id: 'fast', values: ['false', 'true'] }], { fast: 'false' }),
  },
  {
    id: 'plain',
    displayName: 'Plain',
    parameters: [],
    variants: [{ params: [], isDefault: true }],
  },
];
const grokRequest = {
  effort: 'high' as const,
  parameters: [
    { id: 'context', value: '500k' },
    { id: 'fast', value: 'true' },
  ],
};

function bridges() {
  return {
    cursorCredential: { read: async () => apiKey },
    capabilities: { url: capabilityUrl, token: capabilityToken, call: async () => ({ ok: true }) },
    questions: { url: questionUrl, token: questionToken },
  };
}

function sdkFor(create: (options: any) => any, events: any[], extra: any = {}) {
  const directories: string[] = [];
  return {
    directories,
    sdk: {
      version: 'test-sdk',
      Agent: {
        create: async (options: any) => {
          const agent = await create(options);
          directories.push(options.local.cwd);
          return {
            options: {
              ...options,
              allowedProtoTools,
              disallowedProtoTools,
            },
            send: async () => ({
              supports: (operation: string) =>
                operation === 'cancel' || operation === 'stream' || operation === 'wait',
              stream: async function* () {
                for (const event of events) {
                  if (extra.cancelled) return;
                  yield event;
                  if (extra.block) await extra.block;
                }
              },
              wait: async () => ({ status: extra.cancelled ? 'cancelled' : 'finished' }),
              cancel: async () => {
                extra.cancelled = true;
                extra.release?.();
              },
            }),
            [Symbol.asyncDispose]: async () => {
              extra.disposed = true;
            },
            ...agent,
          };
        },
      },
      Cursor: {
        models: {
          list: async ({ apiKey: supplied }: { apiKey: string }) => {
            assert.equal(supplied, apiKey);
            return catalog;
          },
        },
      },
      JsonlLocalAgentStore: class {
        directory: string;
        constructor(directory: string) {
          this.directory = directory;
        }
      },
      emptyFs: () => ({ isolated: true }),
    },
  };
}

test('Cursor detection uses the stored key and never a CLI launcher', async () => {
  await assert.rejects(resolveAgent('cursor'), /no CLI launcher/);
  const missing = await detectAgents({
    resolve: async () => {
      throw new Error('Cursor detection must not resolve a CLI');
    },
    loadCursorSdk: async () => ({ version: 'test-sdk' }),
  });
  const absent: any = missing.find((agent: any) => agent.id === 'cursor');
  assert.equal(absent.installed, true);
  assert.equal(absent.available, false);
  assert.match(absent.error, /API key/);
  const ready = await detectAgents({
    resolve: async () => {
      throw new Error('Cursor detection must not resolve a CLI');
    },
    loadCursorSdk: async () => ({ version: 'test-sdk' }),
    cursorCredential: { read: async () => apiKey },
  });
  const present: any = ready.find((agent: any) => agent.id === 'cursor');
  assert.equal(present.available, true);
  assert.equal(present.supportsCapabilities, true);
  assert.equal(present.supportsEffort, false);
  assert.equal(present.auth, 'unknown');
  assert.equal(present.version, 'test-sdk');
  assert.equal('path' in present, false);
});

test('Cursor model catalog exposes every parameter and its catalog default', async () => {
  const state = sdkFor(async () => ({}), []);
  const listed = await listAgentModels('cursor', '.', new AbortController().signal, {
    sdk: state.sdk,
    cursorCredential: { read: async () => apiKey },
  });
  assert.deepEqual(
    listed.models.map((model: any) => model.id),
    ['grok-4.7', 'composer-2.5', 'plain'],
  );
  assert.deepEqual(listed.unavailable, []);
  assert.equal(listed.models[0].label, 'Grok 4.7');
  assert.equal(listed.models[0].effortParameter, 'reasoning_effort');
  assert.deepEqual(listed.models[0].efforts, ['low', 'high']);
  assert.deepEqual(
    listed.models[0].parameters.map((parameter: any) => [parameter.id, parameter.default]),
    [
      ['context', '500k'],
      ['reasoning_effort', 'high'],
      ['fast', 'true'],
    ],
  );
  assert.deepEqual(listed.models[0].parameters[2].values, [
    { value: 'false', label: 'false' },
    { value: 'true', label: 'Fast' },
  ]);
  assert.equal(listed.models[1].effortParameter, undefined);
  assert.deepEqual(listed.models[1].efforts, []);
  assert.equal(listed.models[1].parameters[0].default, 'false');
  assert.deepEqual(listed.models[2].parameters, []);
  assert.throws(
    () => cursorCatalogEntry({ id: 'not a model' }),
    /Cursor model \(invalid id\) is not a catalog model\./,
  );
  assert.deepEqual(cursorModelSelection(catalog[0], grokRequest), {
    id: 'grok-4.7',
    params: [
      { id: 'context', value: '500k' },
      { id: 'reasoning_effort', value: 'high' },
      { id: 'fast', value: 'true' },
    ],
    maxMode: false,
  });
  assert.deepEqual(
    cursorCheckRequest(listed.models[0], { id: 'reasoning_effort', value: 'low' }),
    {
      model: 'grok-4.7',
      effort: 'low',
      parameters: [
        { id: 'context', value: '500k' },
        { id: 'fast', value: 'true' },
      ],
    },
  );
  assert.equal(validCursorRequestParameters(grokRequest.parameters), true);
  assert.equal(validCursorRequestParameters([]), false);
  assert.equal(
    isCursorBooleanParameter({ values: [{ value: 'false' }, { value: 'true' }] }),
    true,
  );
  assert.equal(
    isCursorBooleanParameter({ values: [{ value: 'true' }, { value: 'false' }, { value: 'auto' }] }),
    false,
  );
  assert.throws(
    () =>
      cursorCatalogEntry({
        ...catalog[0],
        parameters: grokParameters.map((parameter) =>
          parameter.id === 'fast' ? { ...parameter, displayName: '\u200b\u200b' } : parameter,
        ),
      }),
    /invalid fast label/,
  );
  assert.throws(() => cursorModelSelection(catalog[0], { effort: 'max', parameters: grokRequest.parameters }), /reasoning effort/);
  assert.throws(() => cursorModelSelection(catalog[0], { effort: 'high' }), /context/);
  assert.throws(
    () =>
      cursorModelSelection(catalog[0], {
        effort: 'high',
        parameters: [
          { id: 'context', value: '500k' },
          { id: 'speed', value: 'true' },
        ],
      }),
    /does not offer parameter speed/,
  );
  assert.throws(
    () =>
      cursorModelSelection(catalog[0], {
        effort: 'low',
        parameters: [
          { id: 'context', value: '256k' },
          { id: 'fast', value: 'true' },
        ],
      }),
    /no single variant/,
  );
  assert.throws(
    () => cursorModelSelection(catalog[1], { parameters: [{ id: 'fast', value: 'true' }], effort: 'low' }),
    /does not expose a reasoning effort/,
  );
  assert.deepEqual(cursorModelSelection(catalog[2], {}), { id: 'plain', maxMode: false });
  assert.throws(
    () =>
      cursorCatalogEntry({
        id: 'broken',
        parameters: [
          { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
          { id: 'reasoning', values: [{ value: 'medium' }] },
        ],
        variants: [
          {
            params: [
              { id: 'effort', value: 'low' },
              { id: 'reasoning', value: 'medium' },
            ],
            isDefault: true,
          },
        ],
      }),
    /multiple reasoning efforts/,
  );
  assert.throws(
    () =>
      cursorCatalogEntry({
        id: 'claude-opus-5-5',
        displayName: 'Opus',
        parameters: [
          {
            id: 'fast',
            displayName: 'Fast',
            values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
          },
        ],
        variants: cursorVariants([{ id: 'fast', values: ['false', 'true'] }], { fast: 'true' }, [
          { id: 'cyber', value: 'true' },
        ]),
      }),
    /claude-opus-5-5 variant uses unknown parameter cyber/,
  );
  const mixed = {
    id: 'gpt-5.5',
    displayName: 'GPT',
    parameters: [
      {
        id: 'reasoning',
        displayName: 'Reasoning',
        values: [
          { value: 'high', displayName: 'High' },
          { value: 'extra-high', displayName: 'Extra High' },
        ],
      },
    ],
    variants: cursorVariants([{ id: 'reasoning', values: ['high', 'extra-high'] }], {
      reasoning: 'high',
    }),
  };
  const mixedEntry = cursorCatalogEntry(mixed);
  assert.ok(mixedEntry);
  assert.deepEqual(mixedEntry.efforts, []);
  assert.equal(mixedEntry.effortParameter, undefined);
  assert.deepEqual(cursorModelSelection(mixed, { parameters: [{ id: 'reasoning', value: 'extra-high' }] }), {
    id: 'gpt-5.5',
    params: [{ id: 'reasoning', value: 'extra-high' }],
    maxMode: false,
  });
  assert.deepEqual(
    cursorModelSelection(
      {
        id: 'max-model',
        parameters: [
          {
            id: 'fast',
            values: [{ value: 'false' }, { value: 'true' }],
          },
        ],
        variants: [
          { params: [{ id: 'fast', value: 'true' }], isDefault: true, isMaxMode: true },
          { params: [{ id: 'fast', value: 'false' }], isMaxMode: false },
        ],
      },
      { parameters: [{ id: 'fast', value: 'true' }] },
    ),
    { id: 'max-model', params: [{ id: 'fast', value: 'true' }], maxMode: true },
  );
  assert.throws(
    () =>
      cursorCatalogEntry({
        id: 'dup-model',
        parameters: [],
        variants: [{ params: [], isDefault: true }, { params: [] }],
      }),
    /dup-model has more than one variant/,
  );
  assert.throws(
    () =>
      cursorCatalogEntry({
        id: 'bad-max',
        parameters: [],
        variants: [{ params: [], isDefault: true, isMaxMode: 'yes' }],
      }),
    /bad-max has an invalid max-mode flag/,
  );
  assert.throws(() => cursorModelSelection(mixed, { effort: 'high' }), /does not expose a reasoning effort/);
});

test('raw Cursor uses an empty tool catalog and no bridge', async () => {
  const state = sdkFor(async (options) => {
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.mcpServers, {});
    return { options: { ...options, allowedProtoTools: [], disallowedProtoTools: [] } };
  }, [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Raw reply' }] } }]);
  const events: any[] = [];
  const result = await runRawAgent(
    'cursor',
    { prompt: 'Original text', model: 'plain' },
    (event: any) => events.push(event),
    new AbortController().signal,
    { cursorCredential: { read: async () => apiKey }, sdk: state.sdk },
  );
  assert.equal(result.outcome, 'completed');
  assert.ok(events.some((event) => event.type === 'text-delta' && event.delta === 'Raw reply'));
});

test('Cursor streams text, cancels without dropping it, and proves the tool set', async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: any[] = [];
  const state = sdkFor(
    async (options) => {
      calls.push(options);
      return {};
    },
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Ready' }] } }],
    { block: blocked, release },
  );
  const events: any[] = [];
  const control = new AbortController();
  const result = await runAgent(
    'cursor',
    { prompt: 'Check isolation', context: {}, model: 'grok-4.7', ...grokRequest },
    '.',
    (event) => {
      events.push(event);
      if (event.type === 'text-delta') control.abort();
    },
    control.signal,
    { ...bridges(), sdk: state.sdk },
  );
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.delta),
    ['Ready'],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, ['mcp']);
  assert.deepEqual(calls[0].local.settingSources, []);
  assert.equal(calls[0].local.sandboxOptions.enabled, false);
  assert.equal(calls[0].mcpServers.openpe.env.OPENPE_AGENT_BRIDGE_TOKEN, capabilityToken);
  assert.equal(Object.isFrozen(calls[0].mcpServers.openpe.env), true);
  assert.deepEqual(Object.keys(calls[0].mcpServers.openpe.env).sort(), [
    'ELECTRON_RUN_AS_NODE',
    'OPENPE_AGENT_BRIDGE_TOKEN',
    'OPENPE_AGENT_BRIDGE_URL',
    'OPENPE_QUESTIONS_TOKEN',
    'OPENPE_QUESTIONS_URL',
  ]);
  assert.equal(calls[0].mcpServers.openpe.env.OPENPE_AGENT_BRIDGE_URL, capabilityUrl);
  assert.equal(calls[0].mcpServers.openpe.env.OPENPE_QUESTIONS_URL, questionUrl);
  assert.equal(Object.values(calls[0].mcpServers.openpe.env).some((value) => String(value).includes(apiKey)), false);
  assert.equal(calls[0].model.maxMode, false);
  assert.deepEqual(calls[0].local.fs, { isolated: true });
  assert.deepEqual(calls[0].model.params, [
    { id: 'context', value: '500k' },
    { id: 'reasoning_effort', value: 'high' },
    { id: 'fast', value: 'true' },
  ]);
  assert.equal(state.sdk && calls[0].local.cwd.includes('openpe-cursor-'), true);
  await assert.rejects(stat(calls[0].local.cwd), /ENOENT/);
  await assert.rejects(
    runAgent(
      'cursor',
      { prompt: 'Check isolation', context: {}, model: 'typed-by-hand', ...grokRequest },
      '.',
      () => {},
      new AbortController().signal,
      { ...bridges(), sdk: state.sdk },
    ),
    /catalog/,
  );
  assert.equal(calls.length, 1);
});

test('Cursor fails closed when the SDK cannot prove its built-in tools', () => {
  const filesystem = { isolated: true };
  const env = Object.freeze({
    ELECTRON_RUN_AS_NODE: '1',
    OPENPE_AGENT_BRIDGE_URL: capabilityUrl,
    OPENPE_AGENT_BRIDGE_TOKEN: capabilityToken,
    OPENPE_QUESTIONS_URL: questionUrl,
    OPENPE_QUESTIONS_TOKEN: questionToken,
  });
  const options = {
    local: {
      cwd: '/private',
      settingSources: [],
      sandboxOptions: { enabled: false },
      fs: filesystem,
    },
    mcpServers: {
      openpe: {
        type: 'stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../server/agent-mcp.mjs', import.meta.url))],
        cwd: '/private',
        env,
      },
    },
    allowedProtoTools,
    disallowedProtoTools,
  };
  const expected = {
    cwd: '/private',
    fs: filesystem,
    env,
    apiKey,
    capabilityUrl,
    capabilityToken,
    questionUrl,
    questionToken,
  };
  assertCursorSdkTools({ options }, expected);
  assert.throws(
    () =>
      assertCursorSdkTools(
        { options: { ...options, allowedProtoTools: [...allowedProtoTools, 'read_tool_call'] } },
        expected,
      ),
    /built-in tools/,
  );
  assert.throws(
    () => assertCursorSdkTools({ options: { allowedProtoTools: ['mcp_tool_call'] } }, expected),
    /cannot prove/,
  );
  assert.throws(
    () =>
      assertCursorSdkTools(
        { options: { ...options, local: { ...options.local, fs: { isolated: true } } } },
        expected,
      ),
    /host filesystem/,
  );
  const leaked = {
    ...env,
    OPENPE_AGENT_BRIDGE_URL: `${capabilityUrl}/${apiKey}`,
  };
  assert.throws(
    () =>
      assertCursorSdkTools(
        {
          options: {
            ...options,
            mcpServers: { openpe: { ...options.mcpServers.openpe, env: leaked } },
          },
        },
        { ...expected, env: leaked },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not isolated/);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );
  const dirty = { ...env, NODE_OPTIONS: '--require /tmp/injected.js' };
  assert.throws(
    () =>
      assertCursorSdkTools(
        {
          options: {
            ...options,
            mcpServers: { openpe: { ...options.mcpServers.openpe, env: dirty } },
          },
        },
        { ...expected, env: dirty },
      ),
    /not isolated/,
  );
  const wrongBridge = {
    ...env,
    OPENPE_QUESTIONS_URL: 'http://127.0.0.1:9/api/agent-questions/33333333-3333-4333-8333-333333333333',
  };
  assert.throws(
    () =>
      assertCursorSdkTools(
        {
          options: {
            ...options,
            mcpServers: { openpe: { ...options.mcpServers.openpe, env: wrongBridge } },
          },
        },
        { ...expected, env: wrongBridge },
      ),
    /not isolated/,
  );
});

test('Cursor MCP proof accepts only the OpenPE tools and the question bridge', async () => {
  const env = {
    OPENPE_AGENT_BRIDGE_URL: capabilityUrl,
    OPENPE_AGENT_BRIDGE_TOKEN: capabilityToken,
    OPENPE_QUESTIONS_URL: questionUrl,
    OPENPE_QUESTIONS_TOKEN: questionToken,
  };
  await proveCursorMcpTools(env);
  const input = new PassThrough();
  const output = new PassThrough();
  const received: any[] = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      received.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const lines = startAgentMCP({
    input,
    output,
    env,
    request: async (_url, options) => {
      const headers = options?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['X-OpenPE-Agent-Token'], questionToken);
      return new Response(JSON.stringify({ answers: { q1: ['Use 10k'] } }));
    },
  });
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'openpe_ask_user', arguments: { questions: [{ id: 'q1', question: 'Value?' }] } },
    }) + '\n',
  );
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(received[0].result.content[0].text, /Use 10k/);
  input.end();
  lines.close();
  await assert.rejects(
    proveCursorMcpTools({
      OPENPE_AGENT_BRIDGE_URL: capabilityUrl,
      OPENPE_AGENT_BRIDGE_TOKEN: capabilityToken,
      OPENPE_QUESTIONS_URL: questionUrl,
    }),
    /question connection/,
  );
});

test('Cursor stop before send resolves disposes the agent and finishes cancelled', async () => {
  let started!: () => void;
  const sawSend = new Promise<void>((resolve) => {
    started = resolve;
  });
  let disposals = 0;
  const state = sdkFor(
    async () => ({
      send: () => {
        started();
        return new Promise(() => {});
      },
      [Symbol.asyncDispose]: async () => {
        disposals += 1;
      },
    }),
    [],
  );
  const control = new AbortController();
  const pending = runAgent(
    'cursor',
    { prompt: 'Check isolation', context: {}, model: 'grok-4.7', ...grokRequest },
    '.',
    () => {},
    control.signal,
    { ...bridges(), sdk: state.sdk },
  );
  await sawSend;
  control.abort();
  const result = await Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Cursor stop hung before send resolved.')), 1000);
    }),
  ]);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(disposals, 1);
});

test('Cursor stop without cancel support keeps text and does not read later output', async () => {
  let disposals = 0;
  let waited = false;
  let cancelled = false;
  const state = sdkFor(
    async () => ({
      send: async () => ({
        supports: (operation: string) => operation === 'stream' || operation === 'wait',
        stream: async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Kept' }] } };
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Late' }] } };
          await new Promise(() => {});
        },
        wait: async () => {
          waited = true;
          return new Promise(() => {});
        },
        cancel: async () => {
          cancelled = true;
        },
      }),
      [Symbol.asyncDispose]: async () => {
        disposals += 1;
      },
    }),
    [],
  );
  const control = new AbortController();
  const events: any[] = [];
  const result = await Promise.race([
    runAgent(
      'cursor',
      { prompt: 'Check isolation', context: {}, model: 'grok-4.7', ...grokRequest },
      '.',
      (event) => {
        events.push(event);
        if (event.type === 'text-delta') control.abort();
      },
      control.signal,
      { ...bridges(), sdk: state.sdk },
    ),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Cursor stop hung without cancel support.')), 1000);
    }),
  ]);
  assert.equal(result.outcome, 'cancelled');
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.delta),
    ['Kept'],
  );
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
  assert.equal(waited, false);
  assert.equal(cancelled, false);
  assert.equal(disposals, 1);
});

test('Cursor does not send when the retained filesystem is a different object', async () => {
  let sent = false;
  const state = sdkFor(
    async (options) => ({
      options: {
        ...options,
        local: { ...options.local, fs: { isolated: true } },
        allowedProtoTools,
        disallowedProtoTools,
      },
      send: async () => {
        sent = true;
        throw new Error('send must not run');
      },
    }),
    [],
  );
  await assert.rejects(
    runAgent(
      'cursor',
      { prompt: 'Check isolation', context: {}, model: 'grok-4.7', ...grokRequest },
      '.',
      () => {},
      new AbortController().signal,
      { ...bridges(), sdk: state.sdk },
    ),
    /host filesystem/,
  );
  assert.equal(sent, false);
});

test('a malformed Cursor model is excluded with a reason and valid models stay selectable', async () => {
  let creates = 0;
  const state = sdkFor(
    async () => {
      creates += 1;
      return {};
    },
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Ready' }] } }],
  );
  const broken = {
    id: 'claude-opus-5-5',
    displayName: 'Opus',
    parameters: [
      {
        id: 'fast',
        displayName: 'Fast',
        values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
      },
    ],
    variants: cursorVariants([{ id: 'fast', values: ['false', 'true'] }], { fast: 'true' }, [
      { id: 'cyber', value: 'true' },
    ]),
  };
  const explosive = { id: 'explode-1' };
  Object.defineProperty(explosive, 'parameters', {
    get() {
      throw new Error(`sdk boom ${apiKey}`);
    },
  });
  state.sdk.Cursor.models.list = (async () => [
    ...catalog,
    broken,
    { id: 'bad model' },
    { id: 'no-default', parameters: [], variants: [{ params: [] }] },
    explosive,
  ]) as unknown as typeof state.sdk.Cursor.models.list;
  const listed = await listAgentModels('cursor', '.', new AbortController().signal, {
    sdk: state.sdk,
    cursorCredential: { read: async () => apiKey },
  });
  assert.deepEqual(
    listed.models.map((model: any) => model.id),
    ['grok-4.7', 'composer-2.5', 'plain'],
  );
  assert.deepEqual(listed.unavailable, [
    {
      id: 'claude-opus-5-5',
      reason: 'Cursor model claude-opus-5-5 variant uses unknown parameter cyber.',
    },
    {
      id: '(invalid id)',
      reason: 'Cursor model (invalid id) is not a catalog model.',
    },
    {
      id: 'no-default',
      reason: 'Cursor model no-default has no single catalog default.',
    },
    {
      id: 'explode-1',
      reason: 'Cursor model explode-1 is not a catalog model.',
    },
  ]);
  assert.deepEqual(readCursorUnavailableModels(listed.unavailable), listed.unavailable);
  assert.equal(JSON.stringify(listed).includes(apiKey), false);
  assert.equal(JSON.stringify(listed).includes('sdk boom'), false);
  assert.equal(JSON.stringify(listed).includes('bad model'), false);
  assert.throws(
    () => readCursorUnavailableModels([{ id: 'explode-1', reason: `sdk boom ${apiKey}` }]),
    /invalid model catalog/,
  );
  const events: any[] = [];
  const completed = await runAgent(
    'cursor',
    { prompt: 'Check isolation', context: {}, model: 'grok-4.7', ...grokRequest },
    '.',
    (event) => events.push(event),
    new AbortController().signal,
    { ...bridges(), sdk: state.sdk },
  );
  assert.equal(completed.outcome, 'completed');
  assert.equal(creates, 1);
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.delta),
    ['Ready'],
  );
  await assert.rejects(
    runAgent(
      'cursor',
      { prompt: 'Check isolation', context: {}, model: 'claude-opus-5-5' },
      '.',
      () => {},
      new AbortController().signal,
      { ...bridges(), sdk: state.sdk },
    ),
    /Cursor model claude-opus-5-5 variant uses unknown parameter cyber\./,
  );
  await assert.rejects(
    runAgent(
      'cursor',
      { prompt: 'Check isolation', context: {}, model: 'missing-model' },
      '.',
      () => {},
      new AbortController().signal,
      { ...bridges(), sdk: state.sdk },
    ),
    /Choose a Cursor model from the catalog\./,
  );
  assert.equal(creates, 1);
});

test('Cursor model listing fails when the catalog is invalid or has no usable model', async () => {
  const state = sdkFor(async () => ({}), []);
  const options = {
    sdk: state.sdk,
    cursorCredential: { read: async () => apiKey },
  };
  const list = () => listAgentModels('cursor', '.', new AbortController().signal, options);
  state.sdk.Cursor.models.list = (async () => ({ models: catalog })) as unknown as typeof state.sdk.Cursor.models.list;
  await assert.rejects(list(), /Cursor returned an invalid model catalog\./);
  state.sdk.Cursor.models.list = (async () =>
    Array.from({ length: 501 }, () => catalog[2])) as unknown as typeof state.sdk.Cursor.models.list;
  await assert.rejects(list(), /Cursor returned an invalid model catalog\./);
  state.sdk.Cursor.models.list = (async () => []) as unknown as typeof state.sdk.Cursor.models.list;
  await assert.rejects(list(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Cursor returned no usable models.');
    assert.equal((error as { modelListDiagnostic?: boolean }).modelListDiagnostic, true);
    return true;
  });
  state.sdk.Cursor.models.list = (async () => [
    { id: 'bad model' },
    {
      id: 'claude-opus-5-5',
      parameters: [
        {
          id: 'fast',
          values: [{ value: 'false' }, { value: 'true' }],
        },
      ],
      variants: cursorVariants([{ id: 'fast', values: ['false', 'true'] }], { fast: 'true' }, [
        { id: 'cyber', value: 'true' },
      ]),
    },
  ]) as unknown as typeof state.sdk.Cursor.models.list;
  await assert.rejects(list(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Cursor returned no usable models.');
    assert.equal(error.message.includes('cyber'), false);
    assert.equal(error.message.includes('bad model'), false);
    assert.equal(error.message.includes(apiKey), false);
    assert.equal((error as { modelListDiagnostic?: boolean }).modelListDiagnostic, true);
    return true;
  });
});

test('Cursor model listing does not expose SDK exception text', async () => {
  const state = sdkFor(async () => ({}), []);
  state.sdk.Cursor.models.list = async () => {
    throw new Error(`rejected ${apiKey} at the edge`);
  };
  await assert.rejects(
    listAgentModels('cursor', '.', new AbortController().signal, {
      sdk: state.sdk,
      cursorCredential: { read: async () => apiKey },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Cursor rejected the stored API key.');
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );
  state.sdk.Cursor.models.list = async () => {
    throw new Error('connect ECONNREFUSED 10.9.8.7:443');
  };
  await assert.rejects(
    listAgentModels('cursor', '.', new AbortController().signal, {
      sdk: state.sdk,
      cursorCredential: { read: async () => apiKey },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Could not load Cursor models.');
      assert.equal(error.message.includes('ECONNREFUSED'), false);
      return true;
    },
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-cursor-models-'));
  const leaked = await startServer({
    dataDir: directory,
    modelLister: async () => {
      throw new Error(`sdk ${apiKey} exploded`);
    },
  });
  try {
    const response = await fetch(`${leaked.base}/api/models?provider=cursor`, {
      headers: { 'X-OpenPE-Token': leaked.token },
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'Could not load Cursor models.');
    assert.equal(JSON.stringify(body).includes(apiKey), false);
  } finally {
    leaked.close();
    await rm(directory, { recursive: true, force: true });
  }
});
