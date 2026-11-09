'use client';
import { useSyncExternalStore } from 'react';
import type { Point } from '@/lib/circuit';

type RelativeCoordinates = Point & { dx: number; dy: number; distance: number };

// Pointer coordinates are presentation state. Only the readout subscribes, so
// moving across a schematic does not schedule a workbench/editor render.
export function createCanvasCoordinates() {
  let point: Point = { x: 0, y: 0 };
  let origin: Point = { x: 0, y: 0 };
  let relative: RelativeCoordinates = { ...point, dx: 0, dy: 0, distance: 0 };
  const listeners = new Set<() => void>();
  const publish = () => {
    const dx = point.x - origin.x,
      dy = point.y - origin.y;
    relative = { ...point, dx, dy, distance: Math.hypot(dx, dy) };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => point,
    getRelativeSnapshot: () => relative,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (next: Point) => {
      if (point.x === next.x && point.y === next.y) return;
      point = { x: next.x, y: next.y };
      publish();
    },
    resetOrigin: () => {
      if (origin.x === point.x && origin.y === point.y) return;
      origin = { ...point };
      publish();
    },
  };
}

export default function CanvasCoordinates({
  coordinates,
  relative = false,
}: {
  coordinates: ReturnType<typeof createCanvasCoordinates>;
  relative?: boolean;
}) {
  const snapshot = relative ? coordinates.getRelativeSnapshot : coordinates.getSnapshot;
  const point = useSyncExternalStore<Point | RelativeCoordinates>(
    coordinates.subscribe,
    snapshot,
    snapshot,
  );
  return (
    <>
      <span>X {point.x.toFixed(2)}</span>{' '}
      <span className="status-coordinate-next-axis">Y {point.y.toFixed(2)} mm</span>
      {relative && 'dx' in point && (
        <>
          {' '}
          · dx {point.dx.toFixed(2)} dy {point.dy.toFixed(2)} dist {point.distance.toFixed(2)} mm
        </>
      )}
    </>
  );
}
