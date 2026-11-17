import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost, emptyCapabilityInput } from '../api/capabilities';

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function lifecycleFixture() {
  let revision = 'one',
    enabled = true,
    calls = 0;
  let signal!: AbortSignal;
  let acknowledge!: (delivered: boolean) => void;
  let reject!: (error: Error) => void;
  const resultDelivery = new Promise<boolean>((resolve, fail) => {
    acknowledge = resolve;
    reject = fail;
  });
  const host = createCapabilityHost({ revision: () => revision });
  const remove = host.register({
    owner: 'host',
    id: 'project.close',
    kind: 'command',
    description: 'Request close.',
    inputSchema: emptyCapabilityInput,
    available: () => enabled || 'Project inactive.',
    handler: (_, context) => {
      signal = context.signal;
      context.afterResult(() => {
        calls++;
      });
      return { status: 'requested' };
    },
  });
  return {
    host,
    remove,
    resultDelivery,
    acknowledge,
    reject,
    signal: () => signal,
    calls: () => calls,
    revise: () => {
      revision = 'two';
    },
    disable: () => {
      enabled = false;
    },
  };
}

test('lifecycle actions wait for delivered results and local callers receive their result first', async () => {
  const remote = lifecycleFixture();
  assert.deepEqual(
    await remote.host.execute(
      'project.close',
      {},
      {
        expectedRevision: 'one',
        resultDelivery: remote.resultDelivery,
      },
    ),
    { status: 'requested' },
  );
  await nextTask();
  assert.equal(remote.calls(), 0);
  assert.equal(remote.signal().aborted, false);
  remote.acknowledge(true);
  assert.equal(remote.calls(), 0);
  await nextTask();
  assert.equal(remote.calls(), 1);
  remote.acknowledge(true);
  await nextTask();
  assert.equal(remote.calls(), 1);
  const local = lifecycleFixture();
  assert.deepEqual(await local.host.execute('project.close'), { status: 'requested' });
  assert.equal(local.calls(), 0);
  await nextTask();
  assert.equal(local.calls(), 1);
});

test('undelivered lifecycle requests retain Stop, suspension and registration authority', async () => {
  for (const change of [
    'stop',
    'suspend',
    'unregister',
    'dispose',
    'revision',
    'inactive',
    'delivery-failed',
    'delivery-rejected',
  ] as const) {
    const f = lifecycleFixture();
    const control = new AbortController();
    await f.host.execute(
      'project.close',
      {},
      { signal: control.signal, resultDelivery: f.resultDelivery },
    );
    if (change === 'stop') control.abort();
    if (change === 'suspend') {
      f.host.suspend('Closing.');
      f.host.resume();
    }
    if (change === 'unregister') f.remove();
    if (change === 'dispose') f.host.dispose();
    if (change === 'revision') f.revise();
    if (change === 'inactive') f.disable();
    if (change === 'delivery-rejected') f.reject(new Error('Disconnected.'));
    else f.acknowledge(change !== 'delivery-failed');
    await nextTask();
    assert.equal(f.calls(), 0, change);
    if (!['revision', 'inactive'].includes(change)) assert.equal(f.signal().aborted, true, change);
  }
});

test('acknowledged lifecycle actions still cancel before dispatch and cannot defer invalid results', async () => {
  const f = lifecycleFixture();
  const control = new AbortController();
  await f.host.execute(
    'project.close',
    {},
    { signal: control.signal, resultDelivery: f.resultDelivery },
  );
  f.acknowledge(true);
  await Promise.resolve();
  control.abort();
  await nextTask();
  assert.equal(f.calls(), 0);
  const host = createCapabilityHost();
  let calls = 0;
  for (const kind of ['query', 'command'] as const) {
    host.register({
      owner: 'host',
      id: `invalid.${kind}`,
      kind,
      description: 'Invalid result.',
      inputSchema: true,
      handler: (_, context) => {
        context.afterResult(() => {
          calls++;
        });
        return { bad: NaN };
      },
    });
    await assert.rejects(
      kind === 'query' ? host.query('invalid.query') : host.execute('invalid.command'),
      /commands|JSON/,
    );
  }
  await nextTask();
  assert.equal(calls, 0);
});

test('lifecycle availability checks cannot revoke authority and still dispatch an action', async () => {
  for (const revoke of ['suspend', 'unregister'] as const) {
    const host = createCapabilityHost();
    let dispatch = false,
      calls = 0;
    let remove!: () => void;
    remove = host.register({
      owner: 'host',
      id: 'project.close',
      kind: 'command',
      description: 'Close.',
      inputSchema: emptyCapabilityInput,
      available: () => {
        if (dispatch) {
          if (revoke === 'suspend') host.suspend('Closing.');
          else remove();
        }
        return true;
      },
      handler: (_, context) => {
        context.afterResult(() => {
          calls++;
        });
        return { status: 'requested' };
      },
    });
    await host.execute('project.close');
    dispatch = true;
    await nextTask();
    assert.equal(calls, 0, revoke);
  }
});

test('normal remote completion drains only serialized lifecycle actions before revoking its run', async () => {
  const f = lifecycleFixture();
  const control = new AbortController();
  const pending: Promise<void>[] = [];
  await f.host.execute(
    'project.close',
    {},
    {
      signal: control.signal,
      resultDelivery: f.resultDelivery,
      onAfterResult: (completion) => pending.push(completion),
    },
  );
  assert.equal(pending.length, 1);
  let finished = false;
  const completeRun = Promise.allSettled(pending).then(() => {
    finished = true;
    control.abort();
  });
  await nextTask();
  assert.equal(finished, false);
  f.acknowledge(true);
  await completeRun;
  assert.equal(f.calls(), 1);
  assert.equal(finished, true);

  // A long-running command is not part of normal deferred-result draining.
  f.host.register({
    owner: 'host',
    id: 'solver.run',
    kind: 'command',
    description: 'Run.',
    inputSchema: emptyCapabilityInput,
    handler: (_, context) =>
      new Promise((resolve) => {
        context.signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
  });
  const longControl = new AbortController();
  const running = f.host.execute(
    'solver.run',
    {},
    {
      signal: longControl.signal,
      onAfterResult: () => assert.fail('Unresolved commands must not be drained.'),
    },
  );
  longControl.abort();
  await assert.rejects(running, /cancelled/);
});

test('cancelled or rejected deliveries settle deferred completion without executing', async () => {
  for (const stop of [true, false]) {
    const f = lifecycleFixture();
    const control = new AbortController();
    let completion!: Promise<void>;
    await f.host.execute(
      'project.close',
      {},
      {
        signal: control.signal,
        resultDelivery: f.resultDelivery,
        onAfterResult: (value) => {
          completion = value;
        },
      },
    );
    if (stop) control.abort();
    else f.acknowledge(false);
    await completion;
    assert.equal(f.calls(), 0);
  }
});

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
