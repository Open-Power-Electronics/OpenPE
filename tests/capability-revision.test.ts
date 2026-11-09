import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost, emptyCapabilityInput } from '../api/capabilities';

for (const phase of ['availability', 'started'] as const) {
  test(`revision changes during ${phase} prevent a prepared command from starting`, async () => {
    let revision = '1';
    const host = createCapabilityHost({ revision: () => revision });
    let calls = 0;
    host.register({
      owner: 'host',
      id: 'example.change',
      kind: 'command',
      description: 'Change the document.',
      inputSchema: emptyCapabilityInput,
      available: () => {
        if (phase === 'availability') revision = '2';
        return true;
      },
      handler: () => ++calls,
    });
    host.subscribe((event) => {
      if (phase === 'started' && event.type === 'capability.started') revision = '2';
    });

    await assert.rejects(host.execute('example.change', {}, { expectedRevision: '1' }), /changed/);
    assert.equal(calls, 0);
    assert.equal(host.observe().events.at(-1)?.type, 'capability.failed');
    assert.equal(await host.execute('example.change', {}, { expectedRevision: '2' }), 1);
    host.dispose();
  });
}

test('an empty revision is preserved for a matching command', async () => {
  const host = createCapabilityHost({ revision: () => '' });
  host.register({
    owner: 'host',
    id: 'example.change',
    kind: 'command',
    description: 'Change the document.',
    inputSchema: emptyCapabilityInput,
    handler: (_input, context) => ({ revision: context.expectedRevision }),
  });

  assert.deepEqual(await host.execute('example.change', {}, { expectedRevision: '' }), {
    revision: '',
  });
  host.dispose();
});

test('query revision hints remain independent of command preconditions', async () => {
  const host = createCapabilityHost({ revision: () => 'current' });
  host.register({
    owner: 'host',
    id: 'example.read',
    kind: 'query',
    description: 'Read the document.',
    inputSchema: emptyCapabilityInput,
    handler: (_input, context) => ({ revision: context.expectedRevision }),
  });

  assert.deepEqual(await host.query('example.read', {}, { expectedRevision: 'earlier' }), {
    revision: 'earlier',
  });
  host.dispose();
});

test('revision independence is explicit, discoverable and limited to session commands', () => {
  const host = createCapabilityHost();
  const base = {
    owner: 'host' as const,
    id: 'example.stop',
    kind: 'command' as const,
    description: 'Stop session work.',
    inputSchema: emptyCapabilityInput,
    handler: () => null,
    revision: 'independent' as const,
  };
  try {
    for (const mutation of [false, 'document', 'external'] as const)
      assert.throws(() => host.register({ ...base, mutation }), /Only session commands/);
    assert.throws(() => host.register({ ...base, kind: 'query' }), /Only session commands/);
    assert.throws(() => host.register({ ...base, revision: 'unknown' as any }), /revision policy/);
    host.register({ ...base, mutation: 'session' });
    assert.equal(host.catalog().find((item) => item.id === base.id)?.revision, 'independent');
  } finally {
    host.dispose();
  }
});
