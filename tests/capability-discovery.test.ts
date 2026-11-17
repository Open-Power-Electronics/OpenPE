import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCapabilityHost,
  emptyCapabilityInput,
  type CapabilityDescription,
} from '../api/capabilities';

test('discovery filters live capabilities and omits schemas only on explicit compact requests', async () => {
  const host = createCapabilityHost();
  let enabled = false;
  const unregister = host.register({
    id: 'example.edit',
    kind: 'command',
    owner: 'core',
    level: 'object',
    description: 'Edit.',
    available: () => enabled || 'Disabled.',
    inputSchema: emptyCapabilityInput,
    handler: () => null,
  });
  try {
    assert.deepEqual(await host.query('capabilities.list'), host.catalog());
    const full = (await host.query('capabilities.list', {
      ids: ['example.edit'],
    })) as CapabilityDescription[];
    assert.equal(full.length, 1);
    assert.equal(full[0].available, false);
    assert.deepEqual(full[0].inputSchema, emptyCapabilityInput);
    const compact = (await host.query('capabilities.list', {
      prefix: 'example.',
      kind: 'command',
      includeSchema: false,
    })) as Record<string, unknown>[];
    assert.equal(compact.length, 1);
    assert.equal(compact[0].reason, 'Disabled.');
    assert.equal(Object.hasOwn(compact[0], 'inputSchema'), false);
    compact[0].description = 'Poison';
    enabled = true;
    assert.equal(
      (
        (await host.query('capabilities.list', {
          ids: ['example.edit'],
        })) as CapabilityDescription[]
      )[0].available,
      true,
    );
    assert.equal(host.catalog().find((item) => item.id === 'example.edit')!.description, 'Edit.');
    assert.deepEqual(
      await host.query('capabilities.list', { prefix: 'example.', kind: 'query' }),
      [],
    );
    for (const input of [
      { ids: [] },
      { ids: ['example.edit', 'example.edit'] },
      { ids: ['missing'] },
      { includeSchema: 0 },
      { prefix: '' },
      { search: 'edit' },
    ])
      await assert.rejects(host.query('capabilities.list', input));
    unregister();
    await assert.rejects(
      host.query('capabilities.list', { ids: ['example.edit'] }),
      /not registered/,
    );
  } finally {
    host.dispose();
  }
});
