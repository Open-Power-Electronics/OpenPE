'use client';
import { useSyncExternalStore } from 'react';
import type { ModelCadSketch } from './ModelCadSketchPanel';

export type ModelSketchPointer = Pick<ModelCadSketch, 'plane' | 'cursor'>;

/** Each Workbench owns its readout; only this small view subscribes to pointer updates. */
export function createModelSketchCoordinates() {
  let snapshot: ModelSketchPointer | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next: ModelSketchPointer | null) => {
      if (
        snapshot?.plane === next?.plane &&
        snapshot?.cursor?.x === next?.cursor?.x &&
        snapshot?.cursor?.y === next?.cursor?.y
      )
        return;
      snapshot = next
        ? { plane: next.plane, cursor: next.cursor ? { ...next.cursor } : null }
        : null;
      for (const listener of listeners) listener();
    },
  };
}

export default function ModelSketchCoordinates({
  coordinates,
}: {
  coordinates: ReturnType<typeof createModelSketchCoordinates>;
}) {
  const pointer = useSyncExternalStore(
    coordinates.subscribe,
    coordinates.getSnapshot,
    coordinates.getSnapshot,
  );
  if (!pointer) return null;
  return (
    <>
      <span>
        {pointer.plane === 'YZ' ? 'Y' : 'X'} {pointer.cursor?.x.toFixed(2) ?? '—'}
      </span>{' '}
      <span className="status-coordinate-next-axis">
        {pointer.plane === 'XY' ? 'Y' : 'Z'} {pointer.cursor?.y.toFixed(2) ?? '—'} mm
      </span>
    </>
  );
}
