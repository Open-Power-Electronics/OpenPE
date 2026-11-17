import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createCapabilityHost } from '../api/capabilities';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '../lib/workbench-capabilities';

function fixture() {
  let revision = '0',
    available: boolean | string = true;
  const requests: unknown[][] = [],
    errors: string[] = [];
  const host = createCapabilityHost({ revision: () => revision });
  const ports = {
    revision: () => revision,
    projectActions: {
      available: () => available,
      examples: async () => ({ entries: [{ id: 'example-id', title: 'Example' }], warnings: [] }),
      request: (...args: unknown[]) => {
        requests.push(args);
      },
      failed: (message: string) => {
        errors.push(message);
      },
    },
  } as unknown as WorkbenchCapabilityPorts;
  const dispose = registerWorkbenchCapabilities(host, () => ports);
  return {
    host,
    ports,
    dispose,
    requests,
    errors,
    revise: () => {
      revision = '1';
    },
    deactivate: () => {
      available = 'Activate the originating project.';
    },
  };
}

test('workspace requests complete before navigation or project close revokes the run', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.host.query('project.examples'), {
      entries: [{ id: 'example-id', title: 'Example' }],
      warnings: [],
    });
    for (const [id, action, input] of [
      ['project.new', 'new', {}],
      ['project.open', 'open', {}],
      ['project.close', 'close', {}],
      ['project.reveal', 'reveal', {}],
      ['project.openExample', 'example', { id: 'example-id' }],
    ] as const) {
      const count = f.requests.length;
      assert.deepEqual(await f.host.execute(id, input, { actor: 'agent', expectedRevision: '0' }), {
        status: 'requested',
      });
      assert.equal(f.requests.length, count);
      await delay(5);
      assert.equal(f.requests[count][0], action);
      assert.ok(f.requests[count][1] instanceof AbortSignal);
      assert.equal(f.requests[count][2], 'id' in input ? input.id : undefined);
    }
  } finally {
    f.dispose();
    f.host.dispose();
  }
});

for (const invalidate of ['revision', 'origin', 'cancel', 'dispose'] as const)
  test(`workspace request cannot act after ${invalidate} changes`, async () => {
    const f = fixture(),
      control = new AbortController();
    try {
      // A suspended host aborts pending calls; after acknowledgement, explicit
      // teardown must also cancel requests that have not opened a dialog yet.
      const pending = f.host.execute('project.close', {}, { signal: control.signal });
      if (invalidate === 'cancel') {
        control.abort();
        await assert.rejects(pending, /cancel|abort/i);
      } else await pending;
      if (invalidate === 'revision') f.revise();
      if (invalidate === 'origin') f.deactivate();
      if (invalidate === 'dispose') f.dispose();
      await delay(5);
      assert.equal(f.requests.length, 0);
      if (invalidate === 'revision' || invalidate === 'origin')
        assert.ok(f.host.observe().events.some((event) => event.type === 'capability.failed'));
    } finally {
      f.dispose();
      f.host.dispose();
    }
  });

test('workspace operations reject stale review arguments and arbitrary file paths', async () => {
  const f = fixture();
  try {
    f.revise();
    await assert.rejects(
      f.host.execute('project.open', {}, { expectedRevision: '0' }),
      /changed|revision/i,
    );
    await assert.rejects(
      f.host.execute('project.open', { path: 'C:/private/project.kicad_pro' }),
      /input/i,
    );
    f.deactivate();
    assert.equal(f.host.catalog().find((entry) => entry.id === 'project.new')?.available, false);
    await assert.rejects(f.host.execute('project.new'), /originating/);
    assert.equal(f.requests.length, 0);
  } finally {
    f.dispose();
    f.host.dispose();
  }
});

test('versions.restore uses the shared restoration port with cancellation and validated identity', async () => {
  const host = createCapabilityHost();
  let received: unknown[] = [];
  const ports = {
    revision: () => '7',
    historyRestore: async (...args: unknown[]) => {
      received = args;
    },
  } as unknown as WorkbenchCapabilityPorts;
  const dispose = registerWorkbenchCapabilities(host, () => ports);
  try {
    const id = 'a'.repeat(40);
    assert.deepEqual(await host.execute('versions.restore', { id }), { id, revision: '7' });
    assert.equal(received[0], id);
    assert.ok(received[1] instanceof AbortSignal);
    await assert.rejects(host.execute('versions.restore', { id: '../unreachable' }), /input/i);
    await assert.rejects(
      host.execute('versions.restore', { id }, { expectedRevision: '6' }),
      /changed/,
    );
  } finally {
    dispose();
    host.dispose();
  }
});

test('Agent version reads omit private native backing while human history retains it', async () => {
  const host = createCapabilityHost();
  const source = JSON.stringify({
    format: 'openpe',
    project: { id: 'project', name: 'Design' },
    nativeFiles: {
      entry: 'design.kicad_pro',
      files: [{ name: 'model.lib', source: 'PRIVATE_MODEL_SENTINEL' }],
    },
  });
  const ports = {
    revision: () => '0',
    historyRead: async () => source,
  } as unknown as WorkbenchCapabilityPorts;
  const dispose = registerWorkbenchCapabilities(host, () => ports);
  try {
    const input = { id: 'a'.repeat(40) };
    assert.ok(
      JSON.stringify(await host.query('versions.read', input)).includes('PRIVATE_MODEL_SENTINEL'),
    );
    const observed = await host.query('versions.read', input, { actor: 'agent' });
    assert.ok(!JSON.stringify(observed).includes('PRIVATE_MODEL_SENTINEL'));
    assert.equal(JSON.parse((observed as { source: string }).source).project.name, 'Design');
  } finally {
    dispose();
    host.dispose();
  }
});

test('host operations cannot implicitly apply protected Source drafts for an Agent', async () => {
  const host = createCapabilityHost();
  let saves = 0;
  const ports = {
    revision: () => '0',
    beforeAgentCommand: () => {
      throw new Error('Review model Source edits in the editor.');
    },
    save: async () => {
      saves++;
      return 'saved';
    },
  } as unknown as WorkbenchCapabilityPorts;
  const dispose = registerWorkbenchCapabilities(host, () => ports);
  try {
    await assert.rejects(host.execute('project.save', {}, { actor: 'agent' }), /model Source/);
    assert.equal(saves, 0);
    assert.deepEqual(await host.execute('project.save'), { status: 'saved' });
    assert.equal(saves, 1);
  } finally {
    dispose();
    host.dispose();
  }
});
