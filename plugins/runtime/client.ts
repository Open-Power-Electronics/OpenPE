import type { CapabilityHost } from '../../api/capabilities';
import type { PluginManifest } from '../../api/plugins';
import { api } from '../../lib/bridge';
import {
  getWorkbenchPluginCatalog,
  subscribeWorkbenchPlugins,
  workbenchPluginLifecycle,
} from '../../lib/workbench-plugins';
import { createPluginScope } from './capabilities';

/** Per-project registrations only; plugin code never receives the capability host. */
export function registerRuntimePluginCapabilities(host: CapabilityHost) {
  const scopes = new Map<string, { hash: string; dispose: () => void }>();
  function reconcile() {
    const catalog = getWorkbenchPluginCatalog();
    if (!catalog) return;
    const plugins = catalog.plugins.filter((plugin) => plugin.runtime === 'javascript');
    for (const [id, scope] of scopes) {
      if (!plugins.some((plugin) => plugin.id === id && plugin.sha256 === scope.hash)) {
        scope.dispose();
        scopes.delete(id);
      }
    }
    for (const plugin of plugins) {
      if (scopes.has(plugin.id)) continue;
      const manifest = plugin as typeof plugin & PluginManifest;
      const scope = createPluginScope(host, manifest, workbenchPluginLifecycle(plugin.id));
      try {
        for (const command of manifest.contributes.commands ?? []) {
          scope.register({
            owner: 'plugin',
            plugin: plugin.id,
            id: command.id,
            kind: 'query',
            description: command.description,
            inputSchema: command.inputSchema,
            handler: async (input, { signal }) => {
              const context = manifest.permissions.includes('project.read')
                ? { project: await host.query('project.get', {}, { signal }) }
                : null;
              return (
                await api('runtime-plugins/run', {
                  method: 'POST',
                  signal,
                  body: JSON.stringify({
                    id: plugin.id,
                    command: command.id,
                    input,
                    context,
                    sha256: plugin.sha256,
                  }),
                })
              ).json();
            },
          });
        }
        scopes.set(plugin.id, { hash: plugin.sha256!, dispose: () => scope.dispose() });
      } catch (error) {
        scope.dispose();
        throw error;
      }
    }
  }
  const unsubscribe = subscribeWorkbenchPlugins(reconcile);
  reconcile();
  return () => {
    unsubscribe();
    for (const scope of scopes.values()) scope.dispose();
    scopes.clear();
  };
}
