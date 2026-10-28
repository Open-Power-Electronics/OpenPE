import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
writeFileSync('fixture.pid', String(process.pid));
const mode = process.argv[2];
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const delta = (text) => ({
  method: 'item/agentMessage/delta',
  params: { itemId: 'a', delta: text },
});
if (mode === 'claude' || mode === 'claude-annotations') {
  assert.ok(process.argv.includes('--include-partial-messages'));
  assert.equal(process.argv[process.argv.indexOf('--effort') + 1], 'high');
  assert.equal(process.argv[process.argv.indexOf('--model') + 1], 'fixture-model');
  process.stdin.resume();
  let received = '';
  process.stdin.on('data', (chunk) => {
    received += chunk;
  });
  process.stdin.on('end', async () => {
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
    if (e.method === 'initialize') send({ id: e.id, result: {} });
    if (e.method === 'config/read') {
      assert.equal(e.params.includeLayers, false);
      assert.equal(e.params.cwd, process.cwd());
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
                  { reasoningEffort: 'high' },
                  { reasoningEffort: 'xhigh' },
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
        mode.startsWith('codex') ? 'high' : 'low',
      );
      assert.equal(e.params.model, mode.startsWith('codex') ? 'fixture-model' : undefined);
      send({
        id: e.id,
        result: {
          thread: { id: 'thread' },
          model: 'fixture',
          reasoningEffort: e.params.config.model_reasoning_effort,
        },
      });
    }
    if (e.method === 'turn/start') {
      assert.match(e.params.input[0].text, /Fixture/);
      if (mode === 'codex-annotations') {
        assert.equal(e.params.input[1].type, 'image');
        assert.match(e.params.input[1].url, /^data:image\/png;base64,/);
        assert.match(e.params.input[0].text, /Check the resistor/);
        assert.match(e.params.input[0].text, /Reference/);
        writeFileSync('annotation-input.json', JSON.stringify(e.params.input));
      }
      send({ id: e.id, result: { turn: { id: 'turn' } } });
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
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    }
  });
  input.on('close', () => process.exit(0));
}
