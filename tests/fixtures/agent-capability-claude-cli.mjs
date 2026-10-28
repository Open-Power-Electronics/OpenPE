import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const tools = ['openpe_query', 'openpe_execute', 'openpe_observe'];
assert.equal(process.argv[process.argv.indexOf('--tools') + 1], '');
assert.ok(process.argv.includes('--strict-mcp-config'));
for (const tool of tools) assert.ok(process.argv.includes(`mcp__openpe__${tool}`));
const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]);
assert.deepEqual(Object.keys(config.mcpServers), ['openpe']);
const server = config.mcpServers.openpe;
assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1');
assert.equal(server.command, process.execPath);
assert.equal(server.args.length, 1);
assert.match(server.args[0], /agent-mcp\.mjs$/);
process.stdin.resume();
process.stdin.on('end', () => {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const request = (id, method, params = {}) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  child.on('spawn', () => request(1, 'initialize'));
  child.on('error', () => process.exit(1));
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === 1) request(2, 'tools/list');
    if (message.id === 2) {
      assert.deepEqual(
        message.result.tools.map((tool) => tool.name),
        tools,
      );
      request(3, 'tools/call', { name: tools[0], arguments: { name: 'project.snapshot' } });
    }
    if (message.id === 3) {
      assert.notEqual(message.result.isError, true);
      assert.equal(JSON.parse(message.result.content[0].text).revision, '8');
      request(4, 'tools/call', {
        name: tools[1],
        arguments: {
          name: 'schematic.operations',
          input: {
            schematicId: 'sheet',
            operations: [{ type: 'setValue', ref: 'R1', value: '10k' }],
          },
          expectedRevision: '8',
        },
      });
    }
    if (message.id === 4) {
      assert.notEqual(message.result.isError, true);
      request(5, 'tools/call', { name: tools[2], arguments: { after: 0 } });
    }
    if (message.id === 5) {
      assert.equal(JSON.parse(message.result.content[0].text).cursor, 9);
      child.stdin.end();
      send({ type: 'system', subtype: 'init', model: 'fixture' });
      send({
        type: 'assistant',
        message: {
          id: 'answer',
          content: [{ type: 'text', text: 'Claude MCP runtime verified.' }],
        },
      });
      send({ type: 'result', subtype: 'success', result: 'Claude MCP runtime verified.' });
    }
  });
});
