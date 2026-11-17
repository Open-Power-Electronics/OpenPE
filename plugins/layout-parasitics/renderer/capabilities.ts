import type { CapabilityHost } from '../../../api/capabilities';
import type { Project } from '../../../lib/project';
import type { PluginManifest } from '../../../api/plugins';
import manifest from '../manifest.json';
import {
  analyzeLayoutParasitics,
  PARASITICS_THICKNESS_RANGE,
  type ParasiticsInput,
} from '../domain/analysis';
import {
  workbenchPluginAvailability,
  workbenchPluginLifecycle,
} from '../../../lib/workbench-plugins';
import { LAYOUT_PARASITICS_PLUGIN_ID } from '../../catalog.mjs';
import { createPluginScope } from '../../runtime/capabilities';
import { prepareParasiticsStudy, type ParasiticsStudyInput } from '../domain/study';

/** Read the accepted board and commit prepared studies through the shared GUI/Agent Core port. */
export function registerLayoutParasiticsCapability(
  host: CapabilityHost,
  read: () => {
    project: Project | null;
    revision: number;
    sourceDraft: string | null;
    editingBlocked: string | null;
  },
  commit: (project: Project) => boolean,
) {
  function available(state = read()) {
    const plugin = workbenchPluginAvailability(LAYOUT_PARASITICS_PLUGIN_ID);
    if (plugin !== true) return plugin;
    if (state.editingBlocked) return state.editingBlocked;
    if (state.sourceDraft !== null) return 'Apply the Source edits before using Layout Parasitics.';
    return !!state.project?.pcb || 'This project has no PCB layout.';
  }
  const scope = createPluginScope(
    host,
    manifest as PluginManifest,
    workbenchPluginLifecycle(LAYOUT_PARASITICS_PLUGIN_ID),
  );
  const identity = { type: 'string', minLength: 1, maxLength: 200 };
  const thickness = {
    type: 'number',
    minimum: PARASITICS_THICKNESS_RANGE.min,
    maximum: PARASITICS_THICKNESS_RANGE.max,
  };
  const inputSchema = {
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
  };
  scope.register<ParasiticsInput & { boardId: string }>({
    owner: 'plugin',
    plugin: LAYOUT_PARASITICS_PLUGIN_ID,
    id: 'parasitics.measure',
    kind: 'query',
    description:
      'Estimate two-terminal DC resistance, shortest-route length and shortest-route partial inductance (nH, excludes the return path) between same-net pad or via IDs. Copper thickness and via plating are in mm. Inspect Layout for board and endpoint IDs.',
    inputSchema,
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
  scope.register<ParasiticsStudyInput>({
    owner: 'plugin',
    plugin: LAYOUT_PARASITICS_PLUGIN_ID,
    id: 'parasitics.createStudy',
    kind: 'command',
    level: 'operation',
    mutation: 'document',
    review: 'optional',
    description:
      'Measure current same-net PCB pads and insert a compact horizontal series DC R and optional shortest-route partial L between their exact mapped pins in the specified existing schematic, as one undo edit. The exclusive end-pin leaf lead is shortened by 1.27 mm and native LP connection labels remove the ideal bypass. Vias, duplicate pad-number lands, unmapped or co-located pins, non-leaf leads and duplicate endpoint pairs reject without editing. Other schematic branches remain on the start side; this is a terminal-side approximation, not a distributed PCB reconstruction. blockIds identifies the movable compact block and excludes anchored connection labels. Hidden native group fields preserve exact endpoint provenance and support validated PCB-only conductive equivalence; the physical PCB remains unchanged. Native Values use two decimal places with SI units; result values retain measurement precision. No source, load, ground or unsupported simulation model is invented. The result reports omitted inductance outside the model. Thicknesses are in mm.',
    inputSchema: {
      ...inputSchema,
      required: [...inputSchema.required, 'schematicId'],
      properties: { ...inputSchema.properties, schematicId: identity },
    },
    available: () => available(),
    handler: (input, { expectedRevision, signal }) => {
      const state = read();
      const gate = available(state);
      if (gate !== true) throw new Error(gate);
      signal.throwIfAborted();
      if (expectedRevision !== undefined && expectedRevision !== String(state.revision))
        throw new Error(
          'The project changed before adding parasitic components. Measure the current layout again.',
        );
      const { project, ...study } = prepareParasiticsStudy(state.project!, input);
      signal.throwIfAborted();
      if (!commit(project)) throw new Error('The parasitic components were not added. Try again.');
      return { ...study, revision: String(read().revision) };
    },
  });
  return () => scope.dispose();
}
