import type { CapabilityHost } from '../../../api/capabilities';
import { api } from '../../../lib/bridge';
import {
  workbenchPluginLifecycle,
  workbenchPluginAvailability,
} from '../../../lib/workbench-plugins';
import { PCB_DESIGN_PLUGIN_ID } from '../../catalog.mjs';
import manifest from '../manifest.json';
import type { PluginManifest } from '../../../api/plugins';
import { createPluginScope } from '../../runtime/capabilities';

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

export function registerPcbDesignCapability(host: CapabilityHost) {
  const scope = createPluginScope(
    host,
    manifest as PluginManifest,
    workbenchPluginLifecycle(PCB_DESIGN_PLUGIN_ID),
  );
  scope.register<{ document?: (typeof pcbDesignDocuments)[number] }>({
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
  });
  return () => scope.dispose();
}
