import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const [mode, ...args] = process.argv.slice(2);
assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (mode === 'hang') return;
    if (mode === 'overflow') return process.stdout.write('x'.repeat(4_000_001));
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'initialized') return;
  if (message.method === 'config/value/write') {
    assert.deepEqual(Object.keys(message.params).sort(), ['keyPath', 'mergeStrategy', 'value']);
    writeFileSync('plugin-toggle-request.json', JSON.stringify(message.params));
    if (mode === 'approval') return send({ id: 99, method: 'request/approval', params: {} });
    if (mode === 'error')
      return send({ id: message.id, error: { message: 'Provider rejected change' } });
    return send({ id: message.id, result: { status: mode === 'managed' ? 'okOverridden' : 'ok' } });
  }
  assert.ok(message.error, 'Interactive requests must be rejected');
});
