import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '../lib/workbench-capabilities';

function harness() {
  let revision = '7',
    availability: boolean | string = true,
    calls = 0,
    cancel = false;
  const ports: WorkbenchCapabilityPorts = {
    revision: () => revision,
    state: () => null,
    view: () => true,
    sheet: () => {},
    selection: () => {},
    panel: () => {},
    save: async () => 'saved',
    export: async () => 'exported',
    historyList: async () => null,
    historyRead: async () => '',
    historyCreate: async () => null,
    simulation: async () => null,
    enclosureExportAvailable: () => availability,
    enclosureExport: async () => {
      calls++;
      return cancel ? null : { name: 'case.step' };
    },
  };
  const host = createCapabilityHost();
  registerWorkbenchCapabilities(host, () => ports);
  return {
    host,
    ports,
    calls: () => calls,
    setRevision: (value: string) => (revision = value),
    setAvailability: (value: boolean | string) => (availability = value),
    cancelPicker: () => (cancel = true),
  };
}

test('human and Agent share the bounded enclosure STEP host command and picker cancellation', async () => {
  const h = harness();
  try {
    const entry = h.host.catalog().find((item) => item.id === 'enclosure.exportStep')!;
    assert.equal(entry.owner, 'host');
    assert.equal(entry.mutation, 'external');
    assert.equal(entry.level, undefined);
    assert.deepEqual(
      await h.host.execute('enclosure.exportStep', {}, { actor: 'human', expectedRevision: '7' }),
      { status: 'exported', name: 'case.step' },
    );
    h.cancelPicker();
    assert.deepEqual(
      await h.host.execute('enclosure.exportStep', {}, { actor: 'agent', expectedRevision: '7' }),
      { status: 'cancelled' },
    );
    assert.equal(h.calls(), 2);
    await assert.rejects(
      h.host.execute('enclosure.exportStep', { path: 'arbitrary.step' }),
      /Invalid input/,
    );
    assert.equal(h.calls(), 2);
  } finally {
    h.host.dispose();
  }
});

test('unavailable, stale and cancelled enclosure exports do not invoke the native port', async () => {
  const h = harness();
  try {
    h.setAvailability('Apply Source edits before exporting an enclosure.');
    const entry = h.host.catalog().find((item) => item.id === 'enclosure.exportStep')!;
    assert.equal(entry.available, false);
    assert.match(entry.reason!, /Source/);
    await assert.rejects(h.host.execute('enclosure.exportStep'), /Source/);
    h.setAvailability(true);
    h.setRevision('8');
    await assert.rejects(
      h.host.execute('enclosure.exportStep', {}, { expectedRevision: '7' }),
      /changed/,
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(h.host.execute('enclosure.exportStep', {}, { signal: cancelled.signal }), {
      name: 'AbortError',
    });
    assert.equal(h.calls(), 0);
  } finally {
    h.host.dispose();
  }
});

test('closing during native STEP export cancels capability completion after the port returns', async () => {
  const h = harness();
  let complete!: (result: { name: string }) => void, started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  h.ports.enclosureExport = () => {
    started();
    return new Promise((resolve) => (complete = resolve));
  };
  try {
    const request = h.host.execute('enclosure.exportStep');
    await running;
    h.host.suspend('This project is closing.');
    complete({ name: 'case.step' });
    await assert.rejects(request, { name: 'AbortError' });
  } finally {
    h.host.dispose();
  }
});
