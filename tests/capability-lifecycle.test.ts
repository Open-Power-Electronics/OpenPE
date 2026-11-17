import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCapabilityHost,
  emptyCapabilityInput,
  type CapabilityDefinition,
} from '../api/capabilities';

test('unregister retains the registered identity after the caller changes its definition', async () => {
  const host = createCapabilityHost();
  let requestSignal: AbortSignal | undefined;
  const definition: CapabilityDefinition = {
    owner: 'host',
    id: 'example.run',
    kind: 'command',
    description: 'Run the registered command.',
    inputSchema: emptyCapabilityInput,
    handler: (_input, { signal }) => {
      requestSignal = signal;
      return null;
    },
  };
  const unregister = host.register(definition);
  const running = host.execute('example.run');
  definition.id = 'example.renamed';
  unregister();
  assert.equal(requestSignal?.aborted, true);
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(
    host.catalog().some((item) => item.id === 'example.run'),
    false,
  );

  host.register({
    ...definition,
    id: 'example.run',
    handler: () => 'replacement',
  });
  unregister();
  assert.equal(await host.execute('example.run'), 'replacement');
  host.dispose();
});

for (const action of ['suspend', 'unregister', 'dispose'] as const) {
  test(`a started observer can ${action} a request before its handler performs work`, async () => {
    const host = createCapabilityHost();
    let calls = 0;
    const unregister = host.register({
      owner: 'host',
      id: 'example.change',
      kind: 'command',
      description: 'Change the document.',
      inputSchema: emptyCapabilityInput,
      handler: () => ++calls,
    });
    host.subscribe((event) => {
      if (event.type !== 'capability.started') return;
      if (action === 'suspend') host.suspend('The workspace is closing.');
      else if (action === 'unregister') unregister();
      else host.dispose();
    });

    await assert.rejects(host.execute('example.change'), { name: 'AbortError' });
    assert.equal(calls, 0);
    host.dispose();
  });
}

test('an abort during availability checking prevents handler execution', async () => {
  const host = createCapabilityHost();
  const control = new AbortController();
  let calls = 0;
  host.register({
    owner: 'host',
    id: 'example.change',
    kind: 'command',
    description: 'Change the document.',
    inputSchema: emptyCapabilityInput,
    available: () => {
      control.abort();
      return true;
    },
    handler: () => ++calls,
  });

  await assert.rejects(host.execute('example.change', {}, { signal: control.signal }), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
  host.dispose();
});

test('suspension during availability checking prevents commands while retaining queries', async () => {
  const host = createCapabilityHost();
  let commands = 0;
  const available = () => {
    host.suspend('The workspace is closing.');
    return true;
  };
  host.register({
    owner: 'host',
    id: 'example.change',
    kind: 'command',
    description: 'Change the document.',
    inputSchema: emptyCapabilityInput,
    available,
    handler: () => ++commands,
  });
  host.register({
    owner: 'host',
    id: 'example.read',
    kind: 'query',
    description: 'Read the document.',
    inputSchema: emptyCapabilityInput,
    available,
    handler: () => 'current state',
  });

  await assert.rejects(host.execute('example.change'), { name: 'AbortError' });
  assert.equal(commands, 0);
  assert.equal(host.observe().events.at(-1)?.type, 'capability.cancelled');
  assert.equal(await host.query('example.read'), 'current state');
  host.dispose();
});
