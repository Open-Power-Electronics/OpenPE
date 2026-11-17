import { prepareWorkbenchPlugins } from './fixtures/workbench-plugins';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import {
  registerThermalCapabilities,
  type ThermalCapabilityAdapter,
} from '../plugins/layout-thermal/renderer/thermal-capabilities';

await prepareWorkbenchPlugins();

function fixture() {
  const host = createCapabilityHost();
  let enabled = true;
  let visible = true;
  let running = false;
  let received: unknown;
  let finish: (() => void) | null = null;
  const adapter: ThermalCapabilityAdapter = {
    available: () => enabled || 'Enable Layout Thermal first.',
    canRun: () => visible || 'Open Layout Thermal first.',
    read: () => ({ running, received: received ?? null }),
    configure: async (input) => {
      received = input;
      return adapter.read();
    },
    run: (signal) =>
      new Promise((resolve) => {
        running = true;
        finish = () => {
          running = false;
          resolve(adapter.read());
        };
        signal.addEventListener('abort', finish, { once: true });
      }),
    cancel: () => {
      finish?.();
      return { cancelled: true };
    },
    probe: async (input) => input,
    exportImage: async () => ({ exported: true }),
    importSpice: async (input) => {
      received = input;
      return adapter.read();
    },
  };
  const remove = registerThermalCapabilities(host, adapter);
  return {
    host,
    remove,
    hide: () => {
      visible = false;
    },
    disable: () => {
      enabled = false;
    },
  };
}

test('thermal capabilities share validated session inputs and bounded probe coordinates', async () => {
  const { host } = fixture();
  const catalog = host.catalog().filter((entry) => entry.plugin === 'pcb-thermal@openpe');
  assert.deepEqual(
    catalog.map((entry) => entry.id),
    [
      'thermal.status',
      'thermal.configure',
      'thermal.importSpice',
      'thermal.run',
      'thermal.cancel',
      'thermal.probe',
      'thermal.exportImage',
    ],
  );
  assert.equal(catalog.find((entry) => entry.id === 'thermal.run')?.mutation, 'external');
  assert.equal(catalog.find((entry) => entry.id === 'thermal.exportImage')?.mutation, 'external');
  await host.execute('thermal.configure', { config: { ambientC: 40 } }, { actor: 'agent' });
  assert.deepEqual(((await host.query('thermal.status')) as { received: unknown }).received, {
    config: { ambientC: 40 },
  });
  await host.execute('thermal.probe', { point: { x: 1, y: 2 } });
  await host.execute('thermal.importSpice', {});
  assert.deepEqual(((await host.query('thermal.status')) as { received: unknown }).received, {});
  await assert.rejects(
    host.execute('thermal.importSpice', { window: { startS: -1, endS: 1 } }),
    /Invalid input/,
  );
  for (const input of [
    { config: {} },
    { config: { meshSizeMm: 0 } },
    { config: { source: 'arbitrary' } },
    { source: 'deck' },
  ])
    await assert.rejects(host.execute('thermal.configure', input), /Invalid input/);
  await assert.rejects(
    host.execute('thermal.probe', { point: { x: 1, y: 2, node: 5 } }),
    /Invalid input/,
  );
});

test('thermal host cancellation covers a human run, close suspension and plugin removal', async () => {
  const { host, remove } = fixture();
  const first = host.execute('thermal.run', {}, { actor: 'human' });
  await host.execute('thermal.cancel');
  assert.equal(((await first) as { running: boolean }).running, false);
  const closing = host.execute('thermal.run', {}, { actor: 'human' });
  host.suspend('The project is closing.');
  await assert.rejects(closing, /cancelled/);
  await assert.rejects(host.execute('thermal.run'), /closing/);
  host.resume();
  const removed = host.execute('thermal.run');
  remove();
  await assert.rejects(removed, /cancelled/);
  assert.equal(
    host.catalog().some((entry) => entry.id.startsWith('thermal.')),
    false,
  );
});

test('thermal run rechecks visibility and the confirmed plugin gate', async () => {
  const { host, hide, disable } = fixture();
  hide();
  await assert.rejects(host.execute('thermal.run'), /Open Layout Thermal/);
  disable();
  await assert.rejects(
    host.execute('thermal.configure', { config: { ambientC: 25 } }),
    /Enable Layout Thermal/,
  );
  assert.equal(
    host
      .catalog()
      .filter((entry) => entry.plugin === 'pcb-thermal@openpe')
      .every((entry) => !entry.available),
    true,
  );
});
