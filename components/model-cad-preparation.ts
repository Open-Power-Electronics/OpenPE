import type { ProjectCore } from '@/core/project-core';
import type { ModelCadObject } from '@/lib/model-cad';
import { prepareModelCadPreview } from '@/lib/model-cad-preview';

/** Fixed host geometry work; Core alone owns admission and the eventual edit. */
export async function prepareModelCadObjects(
  core: ProjectCore,
  objects: readonly ModelCadObject[],
  signal: AbortSignal,
): Promise<void> {
  const basis = core.getSnapshot();
  for (const object of objects) {
    signal.throwIfAborted();
    const result = await prepareModelCadPreview(object, signal);
    signal.throwIfAborted();
    const current = core.getSnapshot();
    if (
      current.revision !== basis.revision ||
      current.sourceDraft !== basis.sourceDraft ||
      current.editingBlocked ||
      current.project?.pcb?.id !== basis.project?.pcb?.id
    )
      throw new Error('The project changed while CAD geometry was prepared. Try again.');
    core.acceptPreparedModelCadGeometry(object, result.shapeKey);
  }
}
