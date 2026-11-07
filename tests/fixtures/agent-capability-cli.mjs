import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const tools = ['openpe_query', 'openpe_execute', 'openpe_observe'];
assert.ok(process.argv.includes('features.shell_tool=false'));
assert.ok(process.argv.includes('web_search="disabled"'));
assert.ok(process.argv.includes('mcp_servers={}'));
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    assert.equal(message.params.capabilities.experimentalApi, true);
    send({ id: message.id, result: {} });
  } else if (message.method === 'thread/start') {
    assert.deepEqual(
      message.params.dynamicTools.map((tool) => tool.name),
      tools,
    );
    assert.equal(message.params.sandbox, 'read-only');
    assert.match(
      message.params.developerInstructions,
      /Reuse the discovered index and full tool definitions for the rest of this turn/,
    );
    assert.match(
      message.params.developerInstructions,
      /Await its result and reuse that returned simulation state/,
    );
    assert.match(
      message.params.dynamicTools[0].description,
      /Do not repeat the same discovery query/,
    );
    assert.match(
      message.params.dynamicTools[1].description,
      /Never use capabilities.list as a simulation progress check/,
    );
    send({ id: message.id, result: { thread: { id: 'thread' }, model: 'fixture' } });
  } else if (message.method === 'turn/start') {
    assert.match(message.params.input[0].text, /capabilities.list/);
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    send({ method: 'turn/started', params: { turn: { id: 'turn' } } });
    send({
      id: 90,
      method: 'item/tool/call',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'query',
        tool: tools[0],
        arguments: { name: 'capabilities.list' },
      },
    });
  } else if (message.id === 90) {
    assert.equal(message.result.success, true);
    assert.equal(JSON.parse(message.result.contentItems[0].text).accepted, true);
    send({
      id: 91,
      method: 'item/tool/call',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'execute',
        tool: tools[1],
        arguments: {
          name: 'schematic.setValue',
          input: { id: 'R1', value: '10k' },
          expectedRevision: '1',
        },
      },
    });
  } else if (message.id === 91) {
    assert.equal(message.result.success, true);
    send({
      id: 92,
      method: 'item/tool/call',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'observe',
        tool: tools[2],
        arguments: { after: 0 },
      },
    });
  } else if (message.id === 92) {
    assert.equal(message.result.success, true);
    send({
      id: 93,
      method: 'item/tool/call',
      params: {
        threadId: 'another-thread',
        turnId: 'turn',
        callId: 'cross-thread',
        tool: tools[1],
        arguments: { name: 'project.replace' },
      },
    });
  } else if (message.id === 93) {
    assert.equal(message.result.success, false);
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'answer', delta: 'Runtime tools verified.' },
    });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
});
input.on('close', () => process.exit(0));
