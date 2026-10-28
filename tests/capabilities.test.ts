import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost, emptyCapabilityInput } from '../api/capabilities';

test('core capabilities expose a dynamic JSON catalog and share the same validated handler for all actors', async () => {
  const host = createCapabilityHost();
  let enabled = true;
  const calls: unknown[] = [];
  host.register<{ value: number }>({
    owner: 'plugin',
    id: 'example.change',
    kind: 'command',
    description: 'Change the example.',
    mutation: 'document',
    review: 'optional',
    plugin: 'example@openpe',
    inputSchema: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'number' } },
      additionalProperties: false,
    },
    available: () => enabled || 'Enable the example first.',
    handler: (input, context) => {
      calls.push({ input, actor: context.actor, revision: context.expectedRevision });
      return input;
    },
  });
  const catalog = (await host.query('capabilities.list')) as ReturnType<typeof host.catalog>;
  assert.equal(catalog.find((entry) => entry.id === 'example.change')?.review, 'optional');
  assert.equal(catalog.find((entry) => entry.id === 'example.change')?.owner, 'plugin');
  assert.equal(catalog.find((entry) => entry.id === 'capabilities.list')?.owner, 'api');
  assert.deepEqual(
    await host.execute('example.change', { value: 3 }, { actor: 'human', expectedRevision: 'one' }),
    { value: 3 },
  );
  assert.deepEqual(
    await host.execute('example.change', { value: 4 }, { actor: 'agent', expectedRevision: 'two' }),
    { value: 4 },
  );
  assert.deepEqual(calls, [
    { input: { value: 3 }, actor: 'human', revision: 'one' },
    { input: { value: 4 }, actor: 'agent', revision: 'two' },
  ]);
  await assert.rejects(
    host.execute('example.change', { value: 5, command: 'ignored' }),
    /Invalid input/,
  );
  enabled = false;
  assert.equal(host.catalog().find((entry) => entry.id === 'example.change')?.available, false);
  await assert.rejects(host.execute('example.change', { value: 5 }), /Enable the example/);
  assert.equal(calls.length, 2);
});

test('capability architecture metadata is discoverable and rejects inconsistent plugin ownership', async () => {
  const host = createCapabilityHost();
  const base = {
    kind: 'command' as const,
    description: 'Change a domain object.',
    inputSchema: emptyCapabilityInput,
    handler: () => ({ changed: true }),
  };
  host.register({ ...base, id: 'object.change', owner: 'core', level: 'object' });
  host.register({ ...base, id: 'operation.change', owner: 'core', level: 'operation' });
  host.register({
    owner: 'host',
    ...base,
    id: 'host.action',
  });
  host.register({ ...base, id: 'plugin.action', owner: 'plugin', plugin: 'example@openpe' });
  const catalog = (await host.query('capabilities.list')) as ReturnType<typeof host.catalog>;
  assert.equal(catalog.find((item) => item.id === 'object.change')?.level, 'object');
  assert.equal(catalog.find((item) => item.id === 'operation.change')?.level, 'operation');
  assert.equal(catalog.find((item) => item.id === 'host.action')?.owner, 'host');
  assert.equal(catalog.find((item) => item.id === 'host.action')?.level, undefined);
  assert.equal(catalog.find((item) => item.id === 'capabilities.list')?.level, undefined);
  assert.equal(catalog.find((item) => item.id === 'plugin.action')?.owner, 'plugin');
  assert.deepEqual(await host.execute('object.change'), { changed: true });

  for (const metadata of [
    { owner: undefined },
    { owner: 'core', plugin: 'example@openpe' },
    { owner: 'host', plugin: 'example@openpe' },
    { owner: 'api', plugin: 'example@openpe' },
    { owner: 'plugin' },
    { plugin: '' },
    { plugin: '   ' },
    { owner: 'unknown' },
    { level: 'unknown' },
  ]) {
    const before = host.observe().cursor;
    assert.throws(
      () => host.register({ ...base, id: 'invalid.action', ...metadata } as any),
      /owner|plugin|level/i,
    );
    assert.equal(host.observe().cursor, before);
    assert.equal(
      host.catalog().some((item) => item.id === 'invalid.action'),
      false,
    );
  }
});

test('capability inputs, outputs and observations are independent JSON snapshots', async () => {
  const host = createCapabilityHost();
  const input = { values: [1, 2] };
  const output = { values: [3, 4] };
  host.register<{ values: number[] }>({
    owner: 'host',
    id: 'example.read',
    kind: 'query',
    description: 'Read.',
    inputSchema: { type: 'object' },
    handler: (value) => {
      value.values[0] = 99;
      return output;
    },
  });
  const result = (await host.query('example.read', input)) as typeof output;
  assert.deepEqual(input.values, [1, 2]);
  result.values[0] = 100;
  assert.deepEqual(output.values, [3, 4]);
  for (const value of [
    { bad: undefined },
    { bad: NaN },
    { bad: Infinity },
    new Date(),
    [undefined],
  ])
    await assert.rejects(host.query('example.read', value), /JSON/);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(host.query('example.read', circular), /circular/);
  host.register({
    owner: 'host',
    id: 'example.invalid',
    kind: 'query',
    description: 'Invalid.',
    inputSchema: true,
    handler: () => ({ nonfinite: NaN }),
  });
  await assert.rejects(host.query('example.invalid', null), /JSON/);
  const observation = host.observe();
  observation.events[0].type = 'changed';
  assert.notEqual(host.observe().events[0].type, 'changed');
});

test('capability events retain a bounded ordered cursor and observer failures cannot affect execution', async () => {
  const host = createCapabilityHost({ eventLimit: 3 });
  const received: number[] = [];
  host.subscribe(() => {
    throw new Error('observer failure');
  });
  const unsubscribe = host.subscribe((event) => received.push(event.seq));
  for (let value = 0; value < 5; value++) host.emit('example.changed', { value });
  const first = host.observe();
  assert.equal(first.truncated, true);
  assert.deepEqual(
    first.events.map((event) => event.seq),
    [4, 5, 6],
  );
  assert.deepEqual(
    host.observe(5).events.map((event) => event.seq),
    [6],
  );
  assert.deepEqual(received, [2, 3, 4, 5, 6]);
  unsubscribe();
  host.emit('example.changed', null);
  assert.equal(received.length, 5);
  assert.throws(() => host.observe(-1), /cursor/);
});

test('unregister aborts owned executions and disposal cannot unregister a replacement', async () => {
  const host = createCapabilityHost();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const remove = host.register({
    owner: 'host',
    id: 'example.run',
    kind: 'command',
    description: 'Run.',
    inputSchema: emptyCapabilityInput,
    handler: (_input, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ stopped: true }), { once: true });
        started();
      }),
  });
  const running = host.execute('example.run');
  await ready;
  remove();
  await assert.rejects(running, /cancelled/);
  host.register({
    owner: 'host',
    id: 'example.run',
    kind: 'command',
    description: 'Replacement.',
    inputSchema: emptyCapabilityInput,
    handler: () => null,
  });
  remove();
  assert.equal(await host.execute('example.run'), null);
  await assert.rejects(host.query('example.run'), /Unknown query/);
  host.dispose();
  await assert.rejects(host.execute('example.run'), /closed/);
});

test('capability request abort is forwarded while reads remain concurrent with a command', async () => {
  const host = createCapabilityHost();
  let active = false;
  host.register({
    owner: 'host',
    id: 'example.status',
    kind: 'query',
    description: 'Read running state.',
    inputSchema: emptyCapabilityInput,
    handler: () => ({ active }),
  });
  host.register({
    owner: 'host',
    id: 'example.run',
    kind: 'command',
    description: 'Run.',
    inputSchema: emptyCapabilityInput,
    handler: (_input, { signal }) =>
      new Promise((resolve) => {
        active = true;
        signal.addEventListener(
          'abort',
          () => {
            active = false;
            resolve(null);
          },
          { once: true },
        );
      }),
  });
  const control = new AbortController();
  const result = host.execute('example.run', {}, { signal: control.signal });
  assert.deepEqual(await host.query('example.status'), { active: true });
  control.abort();
  await assert.rejects(result, /cancelled/);
  assert.deepEqual(await host.query('example.status'), { active: false });
  assert.equal(
    host.observe().events.some((event) => event.type === 'capability.cancelled'),
    true,
  );
});
