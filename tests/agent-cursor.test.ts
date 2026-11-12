import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { detectAgents, resolveAgent, runAgent } from '../server/agents.mjs';
import { listAgentModels } from '../server/agent-models.mjs';
import {
  assertCursorSdkTools,
  cursorCatalogEntry,
  cursorCheckRequest,
  cursorModelSelection,
  proveCursorMcpTools,
  validCursorRequestParameters,
} from '../server/agent-cursor.mjs';
import { isCursorBooleanParameter } from '../lib/cursor-catalog';
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
  { id: 'not a model' },
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
  assert.equal(cursorCatalogEntry({ id: 'not a model' }), null);
  assert.deepEqual(cursorModelSelection(catalog[0], grokRequest), {
    id: 'grok-4.7',
    params: [
      { id: 'context', value: '500k' },
      { id: 'reasoning_effort', value: 'high' },
      { id: 'fast', value: 'true' },
    ],
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
    /no variant/,
  );
  assert.throws(
    () => cursorModelSelection(catalog[1], { parameters: [{ id: 'fast', value: 'true' }], effort: 'low' }),
    /does not expose a reasoning effort/,
  );
  assert.deepEqual(cursorModelSelection(catalog[2], {}), { id: 'plain' });
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
  const hidden = cursorCatalogEntry({
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
  });
  assert.ok(hidden);
  assert.deepEqual(
    hidden.parameters.map((parameter) => parameter.id),
    ['fast'],
  );
  assert.equal(hidden.effortParameter, undefined);
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
  });
  assert.throws(() => cursorModelSelection(mixed, { effort: 'high' }), /does not expose a reasoning effort/);
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
  assert.equal(Object.values(calls[0].mcpServers.openpe.env).includes(apiKey), false);
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
  const options = {
    local: {
      cwd: '/private',
      settingSources: [],
      sandboxOptions: { enabled: false },
      fs: { isolated: true },
    },
    mcpServers: {
      openpe: {
        type: 'stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../server/agent-mcp.mjs', import.meta.url))],
        cwd: '/private',
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          OPENPE_AGENT_BRIDGE_TOKEN: capabilityToken,
          OPENPE_QUESTIONS_TOKEN: questionToken,
        },
      },
    },
    allowedProtoTools,
    disallowedProtoTools,
  };
  assertCursorSdkTools(
    { options },
    { cwd: '/private', apiKey, capabilityToken, questionToken },
  );
  assert.throws(
    () =>
      assertCursorSdkTools(
        { options: { ...options, allowedProtoTools: [...allowedProtoTools, 'read_tool_call'] } },
        { cwd: '/private', apiKey, capabilityToken, questionToken },
      ),
    /built-in tools/,
  );
  assert.throws(
    () => assertCursorSdkTools({ options: { allowedProtoTools: ['mcp_tool_call'] } }, { cwd: '/private' }),
    /cannot prove/,
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
