'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './bridge';
import type { CapabilityHost } from '@/api/capabilities';

export type PluginAction = 'install' | 'uninstall' | 'enable' | 'disable';
export type WorkbenchPlugin = {
  id: string;
  scope: string;
  name: string;
  marketplace: string;
  description: string;
  version: string;
  installed: boolean;
  origin: 'agent' | 'openpe' | 'unknown';
  enabled: boolean | null;
  managed: boolean;
  icon?: string;
  detail?: string;
  category?: string;
  author?: string;
  capabilities?: string[];
  runtime?: 'builtin' | 'javascript';
  projectDirectory?: string;
  sha256?: string;
  permissions?: string[];
  contributes?: import('../api/plugins').PluginManifest['contributes'];
};
export type WorkbenchPluginCatalog = {
  controlsVersion: number;
  plugins: WorkbenchPlugin[];
  browse: boolean;
  actions: PluginAction[];
  warning: string;
  updatedAt: number;
};
const initial = { catalog: null as WorkbenchPluginCatalog | null, loading: false, error: '' };
let snapshot = initial;
let pending: Promise<WorkbenchPluginCatalog> | null = null;
const listeners = new Set<() => void>();
function publish(next: typeof snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
export function usesBrowserWorkbenchPlugins() {
  return process.env.NODE_ENV === 'development' && typeof window !== 'undefined' && !window.openpe;
}

export function loadWorkbenchPlugins(force = false): Promise<WorkbenchPluginCatalog> {
  if (pending) return pending;
  if (!force && snapshot.catalog && Date.now() - snapshot.catalog.updatedAt < 300000)
    return Promise.resolve(snapshot.catalog);
  publish({ ...snapshot, loading: true, error: '' });
  pending = (async () => {
    try {
      const catalog: WorkbenchPluginCatalog = await (await api('workbench-plugins')).json();
      if (catalog.controlsVersion !== 1 || !Array.isArray(catalog.plugins))
        throw new Error(
          'OpenPE Marketplace needs the updated local service. Save your work and restart OpenPE.',
        );
      publish({ catalog, loading: false, error: '' });
      return catalog;
    } catch (error) {
      publish({ ...snapshot, loading: false, error: (error as Error).message });
      throw error;
    } finally {
      pending = null;
    }
  })();
  return pending;
}
export async function changeWorkbenchPlugin(
  action: PluginAction,
  id: string,
  signal?: AbortSignal,
) {
  try {
    await api('workbench-plugins', {
      method: 'POST',
      body: JSON.stringify({ action, id }),
      signal,
    });
  } finally {
    // Reconcile uncertain writes as well as successes, including every mounted project.
    if (pending) await pending.catch(() => {});
    await loadWorkbenchPlugins(true);
  }
}
export function useWorkbenchPlugins() {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
    () => initial,
  );
  useEffect(() => {
    void loadWorkbenchPlugins().catch(() => {});
  }, []);
  return state;
}

export function workbenchPluginAvailability(id: string): true | string {
  if (!snapshot.catalog)
    return snapshot.error || 'OpenPE plugin state is still loading. Retry when Plugins has loaded.';
  const plugin = snapshot.catalog.plugins.find((plugin) => plugin.id === id);
  return !!plugin?.installed && plugin.enabled === true
    ? true
    : `Install and enable ${plugin?.name ?? id} in Plugins > Marketplace to use its capabilities.`;
}

/** The Plugins UI and Agent adapter use these same application-owned operations. */
export function registerWorkbenchPluginCapabilities(host: CapabilityHost) {
  const dispose = [
    host.register<{ refresh?: boolean }>({
      owner: 'host',
      id: 'workbench.plugins.list',
      kind: 'query',
      description: 'Read the confirmed bundled workbench plugin catalog and lifecycle state.',
      inputSchema: {
        type: 'object',
        properties: { refresh: { type: 'boolean' } },
        additionalProperties: false,
      },
      handler: (input) => loadWorkbenchPlugins(input.refresh ?? false),
    }),
    host.register<{ action: PluginAction; id: string }>({
      owner: 'host',
      id: 'workbench.plugins.change',
      kind: 'command',
      description:
        'Install built-in features, or uninstall, enable or disable a confirmed workbench plugin. Local packages require the native installer.',
      mutation: 'external',
      review: 'optional',
      inputSchema: {
        type: 'object',
        required: ['action', 'id'],
        properties: {
          action: { enum: ['install', 'uninstall', 'enable', 'disable'] },
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 129,
            pattern: '^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*$',
          },
        },
        additionalProperties: false,
      },
      handler: async ({ action, id }, { signal }) => {
        if (signal.aborted) throw new Error('Plugin operation cancelled.');
        const catalog = await loadWorkbenchPlugins();
        if (!catalog.plugins.some((plugin) => plugin.id === id))
          throw new Error('Unknown OpenPE plugin.');
        await changeWorkbenchPlugin(action, id, signal);
        return snapshot.catalog;
      },
    }),
  ];
  const listener = () => {
    host.emit('workbench.plugins.changed', {
      catalog: snapshot.catalog,
      loading: snapshot.loading,
      error: snapshot.error,
    });
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    for (const unregister of dispose) unregister();
  };
}

export function workbenchPluginLifecycle(id: string) {
  return {
    available: () => workbenchPluginAvailability(id),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function getWorkbenchPluginCatalog() {
  return snapshot.catalog;
}
export function subscribeWorkbenchPlugins(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
