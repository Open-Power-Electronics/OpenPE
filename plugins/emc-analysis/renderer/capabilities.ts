import type { CapabilityHost } from '../../../api/capabilities';
import type { PluginManifest } from '../../../api/plugins';
import type { Project } from '../../../lib/project';
import {
  workbenchPluginAvailability,
  workbenchPluginLifecycle,
} from '../../../lib/workbench-plugins';
import { EMC_PLUGIN_ID } from '../../catalog.mjs';
import { createPluginScope } from '../../runtime/capabilities';
import { inspectEmcLayout, EMC_LAYOUT_INPUT_SCHEMA, type EmcLayoutInput } from '../domain/layout';
import { reviewEmcLayout, EMC_REVIEW_INPUT_SCHEMA, type EmcReviewInput } from '../domain/review';
import manifest from '../manifest.json';

/** GUI and Agent inspect the same accepted PCB; no document or host-write authority. */
export function registerEmcCapabilities(
  host: CapabilityHost,
  read: () => {
    project: Project | null;
    revision: number;
    sourceDraft: string | null;
    editingBlocked: string | null;
  },
) {
  function available(state = read()) {
    const plugin = workbenchPluginAvailability(EMC_PLUGIN_ID);
    if (plugin !== true) return plugin;
    if (state.editingBlocked) return state.editingBlocked;
    if (state.sourceDraft !== null) return 'Apply the Source edits before using EMC Analysis.';
    if (!state.project) return 'Open a project before using EMC Analysis.';
    return !!state.project.pcb || 'This project has no PCB layout.';
  }
  const scope = createPluginScope(
    host,
    manifest as PluginManifest,
    workbenchPluginLifecycle(EMC_PLUGIN_ID),
  );
  function checked(expectedRevision?: string) {
    const state = read();
    const gate = available(state);
    if (gate !== true) throw new Error(String(gate));
    if (expectedRevision !== undefined && expectedRevision !== String(state.revision))
      throw new Error('The project changed. Inspect the current layout again.');
    return state;
  }
  scope.register<EmcLayoutInput>({
    id: 'emc.inspectLayout',
    owner: 'plugin',
    plugin: EMC_PLUGIN_ID,
    kind: 'query',
    description:
      'Inspect explicitly selected current PCB net IDs against a user segment-length budget in mm. Returns routed length, longest straight segment, via/pad/zone counts and exact over-budget track evidence. Coverage is always partial; does not establish return continuity, loop area, emissions or standards compliance.',
    inputSchema: EMC_LAYOUT_INPUT_SCHEMA,
    available: () => available(),
    handler: (input, { expectedRevision, signal }) => {
      signal.throwIfAborted();
      const state = checked(expectedRevision);
      const board = state.project?.pcb;
      if (!board) throw new Error('This project has no PCB layout.');
      const result = inspectEmcLayout(board, input);
      signal.throwIfAborted();
      checked(String(state.revision));
      return { boardId: board.id, revision: state.revision, ...result };
    },
  });
  scope.register<EmcReviewInput>({
    id: 'emc.reviewLayout',
    owner: 'plugin',
    plugin: EMC_PLUGIN_ID,
    kind: 'query',
    description:
      'Review the accepted PCB using explicit net roles, reference-net/layer intent, decoupling pad/package bindings, edge-intended connectors and user geometric limits. Returns grouped findings with confidence, measurements, remediation and per-check coverage. No inferred electrical roles, rule-base imports, field solver, compliance pass, native edits or file writes.',
    inputSchema: EMC_REVIEW_INPUT_SCHEMA,
    available: () => available(),
    handler: (input, { expectedRevision, signal }) => {
      signal.throwIfAborted();
      const state = checked(expectedRevision);
      const board = state.project?.pcb;
      if (!board) throw new Error('This project has no PCB layout.');
      const result = reviewEmcLayout(board, input);
      signal.throwIfAborted();
      checked(String(state.revision));
      return { boardId: board.id, revision: state.revision, result };
    },
  });
  return () => scope.dispose();
}
