import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { piIsolationFlags } from '../../server/agent-provider-runtime.mjs';

const mode = process.argv[2];
if (process.argv.includes('--help')) {
  console.log(mode === 'incompatible' ? '--mode --no-tools' : piIsolationFlags.join(' '));
} else if (process.argv.includes('--version')) {
  console.log('pi fixture');
} else {
  for (const flag of piIsolationFlags)
    assert.ok(process.argv.includes(flag), `Missing isolation flag: ${flag}`);
  assert.equal(process.argv[process.argv.indexOf('--mode') + 1], 'rpc');
  assert.ok(!process.argv.includes('--approve'));
  assert.ok(!process.argv.includes('--extension'));
  const send = (record) => process.stdout.write(JSON.stringify(record) + '\n');
  const state = {
    model: { provider: 'fixture', id: 'fixture-model' },
    thinkingLevel: 'high',
  };
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const event = JSON.parse(line);
    if (event.type === 'get_state') {
      send({ id: event.id, type: 'response', command: event.type, success: true, data: state });
    } else if (event.type === 'get_available_models') {
      setTimeout(
        () =>
          send({
            id: event.id,
            type: 'response',
            command: event.type,
            success: true,
            data: {
              models: [
                {
                  ...state.model,
                  name: 'Fixture model',
                  reasoning: true,
                  input: ['text', 'image'],
                },
                { provider: 'fixture', id: '--bad' },
                { provider: 'fixture', id: 'image-only', input: ['image'] },
              ],
            },
          }),
        20,
      );
    } else if (event.type === 'prompt') {
      assert.match(event.message, /Use only the supplied context and history/);
      assert.doesNotMatch(event.message, /Use the OpenPE capability tools/);
      assert.equal(event.message.includes('private-bridge-token'), false);
      if (mode === 'hang') return;
      if (mode === 'images') {
        assert.equal(event.images.length, 1);
        assert.equal(event.images[0].mimeType, 'image/png');
        assert.equal(Buffer.from(event.images[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
      }
      send({
        id: event.id,
        type: 'response',
        command: event.type,
        success: true,
        data: { disposition: 'started' },
      });
      send({ type: 'agent_start' });
      send({ type: 'message_start', message: { role: 'assistant', content: [] } });
      if (mode === 'tool')
        return send({
          type: 'tool_execution_start',
          toolName: 'bash',
          args: { command: 'blocked' },
        });
      if (mode === 'error')
        return send({
          type: 'message_end',
          message: {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'Fixture model failure',
          },
        });
      for (const delta of ['电感 ', 'ripple.'])
        send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
        });
      send({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: '电感 ripple.' }],
        },
      });
      send({ type: 'agent_end', messages: [], willRetry: false });
      send({ type: 'agent_settled', aborted: false });
    } else throw new Error(`Unexpected RPC command: ${event.type}`);
  });
}
