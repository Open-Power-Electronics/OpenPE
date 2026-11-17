import type { Circuit, Point } from './circuit';
import {
  moveSelection,
  rerouteSelectionConnections,
  selectedField,
  transformSelection,
} from './schematic-edit';

export type SchematicMoveOperation = 'rotate' | 'rotateReverse' | 'mirrorX' | 'mirrorY';

/**
 * Build the complete floating pose from the original document. The returned
 * document is also the commit payload, including IDs allocated by connected drag.
 * The source is an immutable transaction snapshot for the gesture's lifetime.
 */
export function previewSchematicMove(
  source: Circuit,
  ids: readonly string[],
  anchor: Point,
  target: Point,
  operations: readonly SchematicMoveOperation[] = [],
  connected = false,
): Circuit {
  if (![anchor.x, anchor.y, target.x, target.y].every(Number.isFinite))
    throw new Error('The movement position must contain finite coordinates.');
  const owners = new Set(ids),
    selection = [...owners].filter((id) => {
      const field = selectedField(id);
      return !field || !owners.has(field.id);
    });
  let posed = source;
  for (const operation of operations)
    posed = transformSelection(posed, selection, operation, anchor, true);
  posed = moveSelection(
    posed,
    selection,
    { x: target.x - anchor.x, y: target.y - anchor.y },
    false,
    true,
  );
  return connected ? rerouteSelectionConnections(source, posed, selection, true) : posed;
}
