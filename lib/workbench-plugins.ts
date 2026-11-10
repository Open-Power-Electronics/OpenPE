'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './bridge';
import type { CapabilityHost } from '@/api/capabilities';
import {
  analyzeLayoutParasitics,
  PARASITICS_THICKNESS_RANGE,
  type ParasiticsInput,
} from './layout-parasitics';
import type { PCB } from './pcb';

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
};
export type WorkbenchPluginCatalog = {
  controlsVersion: number;
  plugins: WorkbenchPlugin[];
  browse: boolean;
  actions: PluginAction[];
  warning: string;
  updatedAt: number;
};
export const SPICE_PLUGIN_ID = 'spice-simulation@openpe';
export const THERMAL_PLUGIN_ID = 'pcb-thermal@openpe';
export const PCB_DESIGN_PLUGIN_ID = 'ai-pcb-layout@openpe';
export const LAYOUT_PARASITICS_PLUGIN_ID = 'layout-parasitics@openpe';
export const pcbDesignDocuments = [
  'workflow',
  'analysis-and-measurement',
  'behavioral-evaluation',
  'cad-and-tools',
  'devices',
  'electrical-layout',
  'electrical-net-table',
  'implementation-and-delivery',
  'insulation-and-copper',
  'regimes-and-standards',
  'topologies',
] as const;
const initial = { catalog: null as WorkbenchPluginCatalog | null, loading: false, error: '' };
let snapshot = initial;
let pending: Promise<WorkbenchPluginCatalog> | null = null;
const listeners = new Set<() => void>();
function publish(next: typeof snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
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
      description: 'Install, uninstall, enable or disable an allowlisted bundled workbench plugin.',
      mutation: 'external',
      review: 'optional',
      inputSchema: {
        type: 'object',
        required: ['action', 'id'],
        properties: {
          action: { enum: ['install', 'uninstall', 'enable', 'disable'] },
          id: {
            enum: [
              SPICE_PLUGIN_ID,
              THERMAL_PLUGIN_ID,
              PCB_DESIGN_PLUGIN_ID,
              LAYOUT_PARASITICS_PLUGIN_ID,
            ],
          },
        },
        additionalProperties: false,
      },
      handler: async ({ action, id }, { signal }) => {
        if (signal.aborted) throw new Error('Plugin operation cancelled.');
        await changeWorkbenchPlugin(action, id, signal);
        return snapshot.catalog;
      },
    }),
    host.register<{ document?: (typeof pcbDesignDocuments)[number] }>({
      owner: 'plugin',
      id: 'pcbDesign.guide',
      kind: 'query',
      plugin: PCB_DESIGN_PLUGIN_ID,
      description:
        'Read the PE Layout Skill workflow (default) or a named offline engineering reference. Read workflow first for scope, review gates and document IDs. Guidance does not run checks or edit the project.',
      inputSchema: {
        type: 'object',
        properties: { document: { enum: [...pcbDesignDocuments] } },
        additionalProperties: false,
      },
      available: () => workbenchPluginAvailability(PCB_DESIGN_PLUGIN_ID),
      handler: async ({ document = 'workflow' }, { signal }) =>
        (await api(`pcb-design/guide?document=${document}`, { signal })).json(),
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

/** Read the originating project's accepted board through the shared GUI and Agent host. */
export function registerLayoutParasiticsCapability(
  host: CapabilityHost,
  read: () => {
    project: { pcb: PCB | null } | null;
    revision: number;
    sourceDraft: string | null;
    editingBlocked: string | null;
  },
) {
  function available(state = read()) {
    const plugin = workbenchPluginAvailability(LAYOUT_PARASITICS_PLUGIN_ID);
    if (plugin !== true) return plugin;
    if (state.editingBlocked) return state.editingBlocked;
    if (state.sourceDraft !== null)
      return 'Apply the Source edits before measuring PCB resistance.';
    return !!state.project?.pcb || 'This project has no PCB layout.';
  }
  const identity = { type: 'string', minLength: 1, maxLength: 200 };
  const thickness = {
    type: 'number',
    minimum: PARASITICS_THICKNESS_RANGE.min,
    maximum: PARASITICS_THICKNESS_RANGE.max,
  };
  return host.register<ParasiticsInput & { boardId: string }>({
    owner: 'plugin',
    plugin: LAYOUT_PARASITICS_PLUGIN_ID,
    id: 'parasitics.measure',
    kind: 'query',
    description:
      'Estimate two-terminal DC resistance and shortest modeled path length between same-net pad or via IDs on the current PCB. Copper thickness and via plating are in mm. Inspect Layout for board and endpoint IDs.',
    inputSchema: {
      type: 'object',
      required: ['boardId', 'startId', 'endId'],
      properties: {
        boardId: identity,
        startId: identity,
        endId: identity,
        copperThicknessMm: thickness,
        viaPlatingMm: thickness,
      },
      additionalProperties: false,
    },
    available: () => available(),
    handler: ({ boardId, ...input }, { expectedRevision, signal }) => {
      const state = read();
      const gate = available(state);
      if (gate !== true) throw new Error(gate);
      signal.throwIfAborted();
      if (expectedRevision !== undefined && expectedRevision !== String(state.revision))
        throw new Error(
          'The project changed before measurement. Measure the current layout again.',
        );
      const board = state.project?.pcb;
      if (!board || board.id !== boardId)
        throw new Error('This PCB layout is no longer in the project.');
      return { boardId, revision: state.revision, ...analyzeLayoutParasitics(board, input) };
    },
  });
}
