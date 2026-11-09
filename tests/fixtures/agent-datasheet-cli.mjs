import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start')
    send({ id: message.id, result: { thread: { id: 'thread' }, model: 'fixture' } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    send({ method: 'turn/started', params: { turn: { id: 'turn' } } });
    send({
      id: 90,
      method: 'item/tool/call',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'page',
        tool: 'openpe_query',
        arguments: { name: 'project.datasheet.page', input: { page: 1 } },
      },
    });
  } else if (message.id === 90) {
    assert.equal(message.result.success, true);
    const [text, image] = message.result.contentItems;
    assert.equal(text.type, 'inputText');
    assert.match(JSON.parse(text.text).text, /Ripple injection circuit/);
    assert.equal(JSON.parse(text.text).image.data, undefined);
    assert.equal(image.type, 'inputImage');
    assert.match(image.imageUrl, /^data:image\/png;base64,iVBOR/);
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'answer', delta: 'PDF image received.' },
    });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
});
input.on('close', () => process.exit(0));
