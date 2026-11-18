// Synthetic ACP server. It never invokes a provider, model, tool, or network.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const [provider, mode] = process.argv.slice(2);
const record = (entry) =>
  appendFileSync(process.env.OPENPE_ACP_FIXTURE_LOG, JSON.stringify(entry) + '\n');
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (request, result) => send({ id: request.id, result });
const sessionId = `fixture-${provider}`;
const args = process.argv.slice(4);
{
  assert.equal(provider, 'deepseek');
  assert.equal(args[args.indexOf('--profile') + 1], 'acp');
  const patch = JSON.parse(readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
  assert.deepEqual(patch.find((entry) => entry.id === 'acp').inject, [
    'acpAppStartup',
    'openpeToolBoundary',
  ]);
  assert.deepEqual(patch.find((entry) => entry.id === 'agent-loop').config, { agents: [] });
  for (const id of ['agent-instructions', 'skill-filesystem', 'session-log-deepseek'])
    assert.equal(patch.find((entry) => entry.id === id).disabled, true);
  assert.ok(
    patch.some((entry) =>
      entry.insert?.some(
        (plugin) => plugin.id === 'openpe-tool-boundary' && plugin.name === './boundary.mjs',
      ),
    ),
  );
  const boundary = await import(pathToFileURL(path.join(process.cwd(), 'boundary.mjs')).href);
  let guard;
  let ready = false;
  boundary.apply({
    tools: {
      guard: (handler) => {
        guard = handler;
      },
    },
    provide: (name, value) => {
      assert.equal(typeof guard, 'function');
      assert.equal(name, 'openpeToolBoundary');
      assert.equal(value, true);
      ready = true;
    },
  });
  assert.equal(ready, true);
  assert.equal(typeof guard({ name: 'filesystem/read' }), 'string');
  assert.equal(typeof guard({ name: 'later-registered-tool' }), 'string');
  assert.equal(process.env.DSH_TELEMETRY_DISABLED, '1');
}
record({ type: 'launch', provider, mode, args, cwd: process.cwd(), pid: process.pid });
let initialized = false;
let sessionReady = false;
let modelSet = false;
const firstModel = '["deepseek-official","deepseek-v4-flash"]';
const secondModel = '["fixture-provider","vendor/second:v2"]';
function configOptions(currentValue) {
  return [
    {
      id: 'model',
      currentValue,
      options: [
        { value: firstModel, name: 'First' },
        { name: 'Grouped', options: [{ value: secondModel, name: 'Second' }] },
        { value: '\u0000', name: 'Reject control characters' },
      ],
    },
  ];
}
let promptRequest;
const pendingTools = new Map();
const finishPrompt = () => {
  send({
    method: 'session/update',
    params: {
      sessionId: 'another-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Wrong session' },
      },
    },
  });
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        title: 'Do not execute this tool',
        rawInput: { command: 'ignored' },
      },
    },
  });
  if (mode !== 'empty') {
    const notifications = ['电感', ' ripple.'].map((text) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    }));
    // One buffered protocol write proves cancellation discards following deltas.
    process.stdout.write(notifications.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
  if (mode === 'cancel') return;
  if (mode === 'error')
    return send({ id: promptRequest.id, error: { code: -32000, message: 'Fixture ACP failure.' } });
  if (mode === 'invalid-json') return process.stdout.write('null\n');
  reply(promptRequest, { stopReason: mode === 'stopped' ? 'max_tokens' : 'end_turn' });
};
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method) record({ type: 'request', method: request.method, params: request.params });
  if (request.id >= 900 && !request.method) {
    const method = pendingTools.get(request.id);
    assert.ok(method, 'Only expected synthetic tool replies are accepted.');
    if (method === 'session/request_permission')
      assert.deepEqual(request.result, { outcome: { outcome: 'cancelled' } });
    else {
      assert.equal(request.error.code, -32601);
      assert.match(request.error.message, /does not grant/);
      assert.equal(request.result, undefined);
    }
    pendingTools.delete(request.id);
    record({ type: 'tool-rejected', method });
    if (!pendingTools.size) finishPrompt();
    return;
  }
  if (request.method === 'initialize') {
    if (mode === 'handshake-hang') return;
    assert.equal(request.params.protocolVersion, 1);
    assert.deepEqual(request.params.clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    initialized = true;
    return reply(request, {
      protocolVersion: mode === 'bad-version' ? 2 : 1,
      agentCapabilities: { promptCapabilities: { image: mode !== 'no-images' } },
    });
  }
  if (request.method === 'session/new') {
    assert.equal(initialized, true);
    assert.equal(realpathSync(request.params.cwd), realpathSync(process.cwd()));
    assert.deepEqual(request.params.mcpServers, []);
    sessionReady = true;
    return reply(request, {
      sessionId,
      configOptions: configOptions(firstModel),
    });
  }
  if (request.method === 'session/set_config_option') {
    assert.equal(sessionReady, true);
    assert.deepEqual(request.params, { sessionId, configId: 'model', value: secondModel });
    modelSet = true;
    return reply(request, { configOptions: configOptions(mode === 'rejected-model' ? firstModel : secondModel) });
  }
  if (request.method === 'session/prompt') {
    assert.equal(sessionReady, true);
    if (mode === 'model' || mode === 'images') assert.equal(modelSet, true);
    assert.equal(request.params.sessionId, sessionId);
    assert.equal(request.params.prompt[0].type, 'text');
    assert.match(request.params.prompt[0].text, /Fixture question/);
    if (mode === 'images') {
      assert.equal(request.params.prompt[1].type, 'image');
      assert.equal(request.params.prompt[1].mimeType, 'image/png');
      assert.equal(
        Buffer.from(request.params.prompt[1].data, 'base64').subarray(1, 4).toString(),
        'PNG',
      );
    }
    promptRequest = request;
    if (mode === 'tools') {
      const methods = [
        'fs/read_text_file',
        'fs/write_text_file',
        'terminal/create',
        'terminal/output',
        'session/request_permission',
      ];
      for (const [index, method] of methods.entries()) {
        const id = 900 + index;
        pendingTools.set(id, method);
        send({
          id,
          method,
          params: { sessionId, options: [{ optionId: 'allow', kind: 'allow_once' }] },
        });
      }
      return;
    }
    return finishPrompt();
  }
  if (request.method === 'session/close') return reply(request, {});
  assert.fail(`Unexpected protocol method: ${request.method}`);
});
input.on('close', () => process.exit(0));
