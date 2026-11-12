import { createInterface } from 'node:readline';
import { realpathSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
writeFileSync('fixture.pid', String(process.pid));
const mode = process.argv[2];
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const delta = (text) => ({
  method: 'item/agentMessage/delta',
  params: { itemId: 'a', delta: text },
});
if (mode.startsWith('claude-catalog')) {
  assert.ok(
    process.argv.includes('--bare'),
    'Catalog initialization must not load hooks or plugins',
  );
  assert.ok(process.argv.includes('--no-session-persistence'));
  assert.ok(process.argv.includes('--strict-mcp-config'));
  assert.equal(process.argv[process.argv.indexOf('--tools') + 1], '');
  assert.deepEqual(JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]), {
    mcpServers: {},
  });
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const message = JSON.parse(line);
    assert.equal(message.type, 'control_request');
    assert.equal(message.request.subtype, 'initialize');
    if (mode === 'claude-catalog-null') return send(null);
    if (mode === 'claude-catalog-array') return send([]);
    if (mode === 'claude-catalog-hang') return;
    if (mode === 'claude-catalog-interactive')
      return send({
        type: 'control_request',
        request_id: 'blocked',
        request: { subtype: 'can_use_tool' },
      });
    if (mode === 'claude-catalog-error')
      return send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: message.request_id,
          error: 'Fixture catalog error',
        },
      });
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {
          account: { email: 'private@example.invalid' },
          models: [
            { value: 'default', displayName: 'Default' },
            {
              value: 'opus',
              displayName: 'Opus',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
            {
              value: 'sonnet',
              displayName: 'Sonnet',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high'],
            },
            {
              value: 'haiku',
              displayName: 'Haiku',
              supportsEffort: false,
              supportedEffortLevels: ['low', 'high'],
            },
            { value: 'fixture-custom', displayName: 'Custom', description: 'Custom model' },
            {
              value: 'fixture-missing-levels',
              displayName: 'Missing levels',
              supportsEffort: true,
            },
            {
              value: 'fixture-invalid-levels',
              displayName: 'Invalid levels',
              supportsEffort: true,
              supportedEffortLevels: 'medium',
            },
            { value: '--bad' },
          ],
        },
      },
    });
  });
  input.on('close', () => process.exit(0));
} else if (mode.startsWith('claude')) {
  assert.ok(process.argv.includes('--include-partial-messages'));
  assert.equal(
    process.env.CLAUDE_CODE_EFFORT_LEVEL,
    process.argv[process.argv.indexOf('--effort') + 1],
  );
  assert.equal(
    process.argv[process.argv.indexOf('--effort') + 1],
    mode.startsWith('claude-effort-') ? mode.slice('claude-effort-'.length) : 'high',
  );
  assert.equal(process.argv[process.argv.indexOf('--model') + 1], 'fixture-model');
  const input = createInterface({ input: process.stdin });
  input.on('line', async (received) => {
    if (JSON.parse(received).type !== 'user') return;
    if (mode === 'claude-annotations') {
      assert.equal(process.argv[process.argv.indexOf('--input-format') + 1], 'stream-json');
      const input = JSON.parse(received);
      assert.equal(input.type, 'user');
      assert.equal(input.message.role, 'user');
      assert.equal(input.message.content[1].type, 'image');
      assert.equal(input.message.content[1].source.media_type, 'image/png');
      assert.equal(input.message.content[1].source.type, 'base64');
      assert.equal(
        Buffer.from(input.message.content[1].source.data, 'base64').subarray(1, 4).toString(),
        'PNG',
      );
      assert.match(input.message.content[0].text, /Check the resistor/);
      assert.match(input.message.content[0].text, /Reference/);
      writeFileSync('annotation-input.json', JSON.stringify(input));
    }
    send({ type: 'system', subtype: 'init', model: 'fixture' });
    send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'a' } } });
    for (const text of ['电感', ' ripple.']) {
      await delay(50);
      send({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      });
    }
    await delay(100);
    send({
      type: 'assistant',
      message: { id: 'a', content: [{ type: 'text', text: '电感 ripple.' }] },
    });
    send({ type: 'result', subtype: 'success', result: '电感 ripple.' });
  });
} else {
  const input = createInterface({ input: process.stdin });
  input.on('line', async (line) => {
    const e = JSON.parse(line);
    if (e.method === 'initialize' && mode !== 'handshake-hang') send({ id: e.id, result: {} });
    if (e.method === 'config/read') {
      assert.equal(e.params.includeLayers, false);
      assert.equal(realpathSync(e.params.cwd), realpathSync(process.cwd()));
      return send(
        mode === 'catalog-config-error'
          ? { id: e.id, error: { message: 'Config unavailable' } }
          : {
              id: e.id,
              result: {
                config: { model: mode === 'catalog-no-default' ? null : 'configured-model' },
              },
            },
      );
    }
    if (e.method === 'model/list') {
      assert.equal(e.params.includeHidden, false);
      if (mode === 'catalog-hang') return;
      if (mode === 'catalog-error')
        return send({ id: e.id, error: { message: 'Fixture catalog error' } });
      if (mode === 'catalog-approval')
        return send({ id: 99, method: 'account/chatgptAuthTokens/refresh', params: {} });
      if (!e.params.cursor)
        return send({
          id: e.id,
          result: {
            data: [
              {
                model: 'fixture-model',
                isDefault: true,
                displayName: 'Fixture Model',
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low' },
                  { reasoningEffort: 'none' },
                  { reasoningEffort: 'minimal' },
                  { reasoningEffort: 'medium' },
                  { reasoningEffort: 'high' },
                  { reasoningEffort: 'xhigh' },
                  { reasoningEffort: 'max' },
                  { reasoningEffort: 'ultra' },
                ],
              },
              null,
              { model: 'hidden', hidden: true },
              { model: '--bad' },
            ],
            nextCursor: 'page2',
          },
        });
      assert.equal(e.params.cursor, 'page2');
      return send({
        id: e.id,
        result: {
          data: [
            { model: 'fixture-second', displayName: 'Second Model', supportedReasoningEfforts: [] },
          ],
          nextCursor: null,
        },
      });
    }
    if (e.method === 'thread/start') {
      assert.equal(e.params.sandbox, 'read-only');
      assert.equal(e.params.approvalPolicy, 'untrusted');
      assert.equal(
        e.params.config.model_reasoning_effort,
        mode === 'codex-model-default'
          ? undefined
          : mode === 'codex-clamped'
            ? 'xhigh'
            : mode.startsWith('codex-effort-')
              ? mode.slice('codex-effort-'.length)
              : mode.startsWith('codex')
                ? 'high'
                : 'medium',
      );
      assert.equal(e.params.model, mode.startsWith('codex') ? 'fixture-model' : undefined);
      send({
        id: e.id,
        result: {
          thread: { id: 'thread' },
          model: 'fixture',
          reasoningEffort:
            mode === 'codex-clamped' ? 'high' : e.params.config.model_reasoning_effort,
        },
      });
    }
    if (e.method === 'turn/start') {
      assert.notEqual(mode, 'codex-clamped', 'A clamped effort must fail before prompting');
      assert.match(e.params.input[0].text, /Fixture/);
      if (mode === 'codex-annotations') {
        assert.equal(e.params.input[1].type, 'image');
        assert.match(e.params.input[1].url, /^data:image\/png;base64,/);
        assert.match(e.params.input[0].text, /Check the resistor/);
        assert.match(e.params.input[0].text, /Reference/);
        writeFileSync('annotation-input.json', JSON.stringify(e.params.input));
      }
      const echoedItems =
        mode === 'codex-large-echo'
          ? [
              {
                type: 'userMessage',
                id: 'user',
                content: [
                  ...e.params.input,
                  { type: 'image', url: 'data:image/png;base64,' + 'A'.repeat(2_100_000) },
                ],
              },
            ]
          : undefined;
      send({ id: e.id, result: { turn: { id: 'turn', items: echoedItems } } });
      if (echoedItems) {
        for (const method of ['item/started', 'item/completed'])
          send({ method, params: { threadId: 'thread', turnId: 'turn', item: echoedItems[0] } });
        send({
          method: 'item/completed',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: {
              type: 'dynamicToolCall',
              id: 'result-echo',
              tool: 'openpe_query',
              contentItems: [{ type: 'inputText', text: 'R'.repeat(2_100_000) }],
              success: true,
            },
          },
        });
      }
      if (mode === 'codex-oversized-answer') return send(delta('A'.repeat(2_100_000)));
      if (mode.startsWith('codex-steer')) {
        send(delta('Initial response.'));
        return;
      }
      if (mode === 'approval')
        return send({ id: 90, method: 'item/commandExecution/requestApproval', params: {} });
      if (mode === 'failure')
        return send({
          method: 'turn/completed',
          params: { turn: { status: 'failed', error: { message: 'Fixture failure' } } },
        });
      if (mode === 'disconnect') return process.exit(0);
      if (mode === 'hang') return;
      send({ method: 'turn/started', params: { turn: { id: 'turn' } } });
      send(delta('电感'));
      await delay(100);
      send(delta(' ripple.'));
      await delay(100);
      send({
        method: 'item/completed',
        params: { item: { id: 'a', type: 'agentMessage', text: '电感 ripple.' } },
      });
      send({
        method: 'turn/completed',
        params: { turn: { id: 'turn', status: 'completed', items: echoedItems } },
      });
    }
    if (e.method === 'turn/steer') {
      assert.ok(mode.startsWith('codex-steer'));
      assert.equal(e.params.threadId, 'thread');
      assert.equal(e.params.expectedTurnId, 'turn');
      assert.deepEqual(e.params.input, [{ type: 'text', text: 'Use 24 V. $(literal)' }]);
      if (mode === 'codex-steer-reject')
        send({ id: e.id, error: { message: 'Steering rejected' } });
      else if (mode !== 'codex-steer-close') {
        send({ id: e.id, result: { turnId: 'turn' } });
        send(delta(' Using 24 V.'));
      }
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
  });
  input.on('close', () => process.exit(0));
}
