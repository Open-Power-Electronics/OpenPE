import type { CapabilityHost } from '../api/capabilities';
import { ProjectCore, coreCommandDefinitions, coreQueryDefinitions } from './project-core';
import { parseProject, type Project } from '../lib/project';
import type { ModelCadObject } from '../lib/model-cad';
import { agentCoreResult, prepareAgentCoreInput } from '../lib/agent-project-access';

/** Register the same document engine for human and Agent transports. */
export function registerProjectCapabilities(
  host: CapabilityHost,
  core: ProjectCore,
  options: {
    prepareModelCad?: (objects: readonly ModelCadObject[], signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const dispose = [
    ...coreQueryDefinitions.map((definition) =>
      host.register({
        ...definition,
        kind: 'query',
        owner: 'core',
        available: () => {
          if (definition.id === 'modelCad.get')
            return !!core.getSnapshot().project?.pcb || 'This project has no PCB layout.';
          if (definition.id === 'layout.placement.preview') {
            const snapshot = core.getSnapshot();
            if (snapshot.editingBlocked) return snapshot.editingBlocked;
            if (snapshot.sourceDraft !== null)
              return 'Apply the Source edits before previewing placement.';
            return !!snapshot.project?.pcb || 'This project has no PCB layout.';
          }
          if (!['schematic.erc', 'layout.drc'].includes(definition.id)) return true;
          const snapshot = core.getSnapshot();
          if (snapshot.editingBlocked) return snapshot.editingBlocked;
          if (snapshot.sourceDraft !== null)
            return 'Apply the Source edits before running rule checks.';
          if (!snapshot.project) return 'Open a project before running rule checks.';
          if (definition.id === 'layout.drc' && !snapshot.project.pcb)
            return 'This project has no PCB layout.';
          return true;
        },
        handler: async (input, context) => {
          const result = await core.query(definition.id, input, { signal: context.signal });
          return context.actor === 'agent' ? agentCoreResult(result) : result;
        },
      }),
    ),
    ...coreCommandDefinitions.map((definition) =>
      host.register({
        ...definition,
        kind: 'command',
        owner: 'core',
        mutation: ['source.update', 'source.updateFile', 'source.discard'].includes(definition.id)
          ? 'session'
          : 'document',
        review: 'optional',
        available: () => {
          const snapshot = core.getSnapshot();
          if (snapshot.editingBlocked) return snapshot.editingBlocked;
          if (snapshot.sourceDraft !== null && !definition.id.startsWith('source.'))
            return 'Apply the Source edits before changing the project.';
          if (definition.id === 'history.undo' && !snapshot.canUndo)
            return 'There is no edit to undo.';
          if (definition.id === 'history.redo' && !snapshot.canRedo)
            return 'There is no edit to redo.';
          if (definition.id.startsWith('layout.') && !snapshot.project?.pcb)
            return 'This project has no PCB layout.';
          if (definition.id.startsWith('modelCad.') && !snapshot.project?.pcb)
            return 'This project has no PCB layout.';
          if (
            !snapshot.project &&
            !definition.id.startsWith('source.') &&
            definition.id !== 'project.replace'
          )
            return 'Open a project before using this command.';
          return true;
        },
        handler: (input, context) => {
          const basis = core.getSnapshot();
          if (context.actor === 'agent') input = prepareAgentCoreInput(definition.id, input, basis);
          const result = (value: unknown) =>
            context.actor === 'agent' ? agentCoreResult(value) : value;
          if (
            context.expectedRevision !== undefined &&
            context.expectedRevision !== String(basis.revision)
          )
            throw new Error(
              'The project changed since this command was prepared. Query it again before continuing.',
            );
          let candidate: Project | null = null;
          let replay = input;
          if (definition.id.startsWith('modelCad.')) {
            const preview = core.previewModelCadCommand(definition.id, input);
            candidate = preview.project;
            replay = preview.input;
          } else if (definition.id === 'source.apply') {
            try {
              candidate = core.previewSource();
            } catch {
              // Preserve the ordinary Core diagnostic/error event for invalid
              // native drafts before the host attempts geometry preparation.
              return result(
                core.execute(definition.id, input, {
                  expectedRevision: context.expectedRevision,
                }),
              );
            }
          } else if (definition.id === 'project.replace')
            candidate = parseProject((input as { source: string }).source);
          const pending = candidate ? core.pendingModelCadGeometry(candidate) : [];
          if (!pending.length)
            return result(
              core.execute(definition.id, replay, {
                expectedRevision: context.expectedRevision,
              }),
            );
          if (!options.prepareModelCad)
            throw new Error('The Model CAD geometry kernel is unavailable.');
          return (async () => {
            await options.prepareModelCad!(pending, context.signal);
            context.signal.throwIfAborted();
            const current = core.getSnapshot();
            if (
              current.revision !== basis.revision ||
              current.sourceDraft !== basis.sourceDraft ||
              current.editingBlocked
            )
              throw new Error('The project changed while CAD geometry was prepared. Try again.');
            return result(
              core.execute(definition.id, replay, {
                expectedRevision: String(basis.revision),
              }),
            );
          })();
        },
      }),
    ),
    core.subscribe((event) =>
      host.emit(event.type, {
        revision: String(event.revision),
        hasProject: !!event.snapshot.project,
        sourcePending: event.snapshot.sourceDraft !== null,
        canUndo: event.snapshot.canUndo,
        canRedo: event.snapshot.canRedo,
        editingBlocked: event.snapshot.editingBlocked,
      }),
    ),
  ];
  return () => {
    for (const unregister of dispose.reverse()) unregister();
  };
}
