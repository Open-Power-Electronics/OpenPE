import { prepareWorkbenchPlugins } from './fixtures/workbench-plugins';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { resolveAgentCapability, type AgentCapabilityRequest } from '../lib/chat-stream';
import {
  registerSimulationCapabilities,
  type SimulationCapabilityAdapter,
} from '../plugins/spice-simulation/renderer/simulation-capabilities';

await prepareWorkbenchPlugins();

function fixture(revision?: () => string) {
  let enabled = true;
  let visible = true;
  let running = false;
  let configured = 0;
  let probes = 0;
  let stop: (() => void) | undefined;
  const adapter: SimulationCapabilityAdapter = {
    available: () => enabled || 'Enable SPICE Simulation first.',
    canRun: () => visible || 'Open Simulation first.',
    read: () => ({ enabled, visible, running, configured, probes }),
    configure: async () => {
      configured++;
      return adapter.read();
    },
    probes: async () => {
      probes++;
      return adapter.read();
    },
    run: (signal) =>
      new Promise((resolve) => {
        running = true;
        stop = () => {
          running = false;
          resolve(adapter.read());
        };
        signal.addEventListener('abort', stop, { once: true });
      }),
    cancel: () => {
      stop?.();
      return { cancelled: true };
    },
  };
  const host = createCapabilityHost({ revision });
  const remove = registerSimulationCapabilities(host, adapter);
  return {
    host,
    remove,
    disable: () => {
      enabled = false;
    },
    hide: () => {
      visible = false;
    },
    adapter,
  };
}

test('bundled simulation capabilities publish schemas and use the same commands for human and Agent', async () => {
  const { host } = fixture();
  const catalog = host.catalog().filter((entry) => entry.plugin === 'spice-simulation@openpe');
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [
      'simulation.status',
      'simulation.configure',
      'simulation.probes',
      'simulation.run',
      'simulation.cancel',
    ],
  );
  assert.equal(
    catalog
      .filter((entry) => entry.kind === 'command')
      .every((entry) => entry.review === (entry.mutation === 'document' ? 'optional' : 'none')),
    true,
  );
  assert.equal(catalog.find((entry) => entry.id === 'simulation.run')?.mutation, 'document');
  await host.execute(
    'simulation.configure',
    { config: { stop: 0.01, step: 2e-7 } },
    { actor: 'agent' },
  );
  await host.execute('simulation.configure', { drafts: { stop: '1e-' } }, { actor: 'human' });
  await host.execute('simulation.probes', { target: { kind: 'voltage', id: 'wire', pin: 1 } });
  assert.deepEqual(await host.query('simulation.status'), {
    enabled: true,
    visible: true,
    running: false,
    configured: 2,
    probes: 1,
  });
  await assert.rejects(
    host.execute('simulation.configure', { config: { stop: 0 } }),
    /Invalid input/,
  );
  await assert.rejects(
    host.execute('simulation.configure', { source: 'override' }),
    /Invalid input/,
  );
  await assert.rejects(
    host.execute('simulation.probes', { target: { kind: 'voltage', id: 'wire', pin: '1' } }),
    /Invalid input/,
  );
});

test('simulation commands recheck live plugin and presentation gates before executing', async () => {
  const { host, disable, hide } = fixture();
  hide();
  await assert.rejects(host.execute('simulation.run'), /Open Simulation/);
  assert.equal(((await host.query('simulation.status')) as { running: boolean }).running, false);
  disable();
  for (const id of [
    'simulation.configure',
    'simulation.probes',
    'simulation.run',
    'simulation.cancel',
  ])
    assert.equal(host.catalog().find((entry) => entry.id === id)?.available, false);
  await assert.rejects(
    host.execute('simulation.configure', { config: { stop: 0.01 } }),
    /Enable SPICE/,
  );
});

test('simulation run remains awaitable while status and cancel share the host, with no solver timeout', async () => {
  const { host, remove } = fixture();
  const run = host.execute('simulation.run', {}, { actor: 'agent' });
  assert.equal(((await host.query('simulation.status')) as { running: boolean }).running, true);
  await host.execute('simulation.cancel', {}, { actor: 'human' });
  assert.equal(((await run) as { running: boolean }).running, false);
  const control = new AbortController();
  const next = host.execute('simulation.run', {}, { signal: control.signal });
  control.abort();
  await assert.rejects(next, /cancelled/);
  const last = host.execute('simulation.run');
  remove();
  await assert.rejects(last, /cancelled/);
  assert.equal(
    host.catalog().some((entry) => entry.id.startsWith('simulation.')),
    false,
  );
  assert.equal(
    host.observe().events.some((event) => event.type === 'simulation.ready'),
    true,
  );
});

test('Stop ignores project revisions while Run and configuration retain stale-edit protection', async () => {
  let revision = 'initial';
  const { host } = fixture(() => revision);
  try {
    assert.equal(
      host.catalog().find((item) => item.id === 'simulation.cancel')?.revision,
      'independent',
    );
    const run = host.execute('simulation.run', {}, { expectedRevision: revision });
    revision = 'edited';
    await assert.rejects(
      host.execute('simulation.configure', {}, { expectedRevision: 'initial' }),
      /project changed/,
    );
    await assert.rejects(
      host.execute('simulation.run', {}, { expectedRevision: 'initial' }),
      /project changed/,
    );
    for (const actor of ['human', 'agent'] as const)
      assert.deepEqual(
        await host.execute('simulation.cancel', {}, { actor, expectedRevision: 'initial' }),
        { cancelled: true },
      );
    assert.equal(((await run) as { running: boolean }).running, false);
  } finally {
    host.dispose();
  }
});

test('Agent Stop executes immediately in Review and retains schema and lifecycle gates', async () => {
  const { host, disable, remove } = fixture(() => 'newer');
  const request: AgentCapabilityRequest = {
    type: 'capability-request',
    runId: 'run',
    sessionId: 'session',
    requestId: 'stop',
    token: 'token',
    tool: 'openpe_execute',
    arguments: { name: 'simulation.cancel', input: {} },
  };
  const stop = () => resolveAgentCapability(request, host, 'auto', () => assert.fail());
  try {
    const run = host.execute('simulation.run');
    const reviews: unknown[] = [];
    await resolveAgentCapability(request, host, 'review', (command) => reviews.push(command));
    assert.equal(reviews.length, 0);
    assert.equal(((await host.query('simulation.status')) as { running: boolean }).running, false);
    assert.deepEqual(await stop(), { cancelled: true });
    await run;
    await assert.rejects(
      host.execute('simulation.cancel', { unexpected: true }, { expectedRevision: 'old' }),
      /Invalid input/,
    );
    const control = new AbortController();
    control.abort();
    await assert.rejects(
      host.execute('simulation.cancel', {}, { signal: control.signal }),
      /cancelled/,
    );
    host.suspend('Closing');
    await assert.rejects(stop(), /Closing/);
    host.resume();
    disable();
    await assert.rejects(stop(), /Enable SPICE/);
    remove();
    await assert.rejects(stop(), /Unknown command capability/);
    host.dispose();
    await assert.rejects(stop(), /closed/);
  } finally {
    host.dispose();
  }
});
