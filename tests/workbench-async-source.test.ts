import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '../lib/workbench-capabilities';

for (const [id, input, method] of [
  ['workbench.view', { view: 'layout' }, 'view'],
  ['workbench.sheet', { id: 'sheet' }, 'sheet'],
  ['workbench.panel', { panel: 'layers' }, 'panel'],
  ['project.save', {}, 'save'],
  ['project.export', {}, 'export'],
] as const) {
  test(`${id} forwards cancellation through asynchronous Source preparation`, async () => {
    const host = createCapabilityHost();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observed: AbortSignal | undefined;
    const handler = async (...args: unknown[]) => {
      observed = args.at(-1) as AbortSignal;
      entered();
      await new Promise<never>((_resolve, reject) =>
        observed!.addEventListener('abort', () => reject(observed!.reason), { once: true }),
      );
    };
    const ports = {
      revision: () => '0',
      state: () => ({}),
      [method]: handler,
    } as unknown as WorkbenchCapabilityPorts;
    const dispose = registerWorkbenchCapabilities(host, () => ports);
    try {
      const control = new AbortController();
      const request = host.execute(id, input, { actor: 'agent', signal: control.signal });
      await started;
      assert.ok(observed instanceof AbortSignal);
      const rejection = assert.rejects(request, /cancel|abort/i);
      control.abort(new Error('Cancelled before Source publication'));
      await rejection;
      assert.equal(observed.aborted, true);
    } finally {
      dispose();
      host.dispose();
    }
  });
}
