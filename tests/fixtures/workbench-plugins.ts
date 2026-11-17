import { bundledWorkbenchCatalog } from '../../server/workbench-plugins.mjs';
import { loadWorkbenchPlugins } from '../../lib/workbench-plugins';

/** Confirm the real shared catalog before exercising renderer-only adapters. */
export async function prepareWorkbenchPlugins() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      openpe: { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) },
    },
  });
  globalThis.fetch = async () => Response.json(bundledWorkbenchCatalog());
  try {
    await loadWorkbenchPlugins(true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}
