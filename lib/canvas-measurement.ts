export type MeasurementPoint = {
  x: number;
  y: number;
  z: number;
  estimated?: true;
  snapped?: true;
};
export type Measurement = {
  start: MeasurementPoint | null;
  end: MeasurementPoint | null;
  complete: boolean;
  hover: MeasurementPoint | null;
};

export function measurementDistance(start: MeasurementPoint, end: MeasurementPoint) {
  const x = end.x - start.x;
  const y = end.y - start.y;
  const z = end.z - start.z;
  return { x, y, z, distance: Math.hypot(x, y, z) };
}

/** Native +X toward +Y, plus elevation out of XY for spatial measurements. */
export function measurementAngles(start: MeasurementPoint, end: MeasurementPoint) {
  const { x, y, z } = measurementDistance(start, end);
  const planar = Math.hypot(x, y);
  return {
    angle: planar > 1e-9 ? (Math.atan2(y, x) * 180) / Math.PI : null,
    elevation: Math.hypot(planar, z) > 1e-9 ? (Math.atan2(z, planar) * 180) / Math.PI : null,
  };
}

/** The same 100-pixel reference used by the lower-left Layout scale bar. */
export function canvasScaleLength(unitsPerPixel: number) {
  return (
    [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
      .filter((length) => length / unitsPerPixel <= 100)
      .at(-1) ?? 0.1
  );
}

/** One interval per scale-bar length; very long offscreen rulers thin by powers of ten. */
export function measurementTicks(distance: number, unitsPerPixel: number) {
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite(unitsPerPixel) ||
    distance <= 1e-9 ||
    unitsPerPixel <= 0
  )
    return [];
  const interval = canvasScaleLength(unitsPerPixel);
  const stride = 10 ** Math.max(0, Math.ceil(Math.log10(distance / interval / 200)));
  const step = interval * stride;
  if (!Number.isFinite(step) || step <= 0) return [];
  const count = Math.min(200, Math.floor(distance / step + 1e-9));
  return Array.from({ length: count + 1 }, (_, index) => ({
    distance: index * step,
    fraction: Math.min(1, (index * step) / distance),
  }));
}

/** One transient two-point measurement per editor, outside documents and undo. */
export function createCanvasMeasurement() {
  let snapshot: Measurement = { start: null, end: null, complete: false, hover: null };
  const listeners = new Set<() => void>();
  const publish = (next: Measurement) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const valid = (point: MeasurementPoint | null): point is MeasurementPoint =>
    !!point &&
    [point.x, point.y, point.z].every(Number.isFinite) &&
    (!snapshot.start ||
      snapshot.complete ||
      Number.isFinite(measurementDistance(snapshot.start, point).distance));
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      if (snapshot.start || snapshot.hover)
        publish({ start: null, end: null, complete: false, hover: null });
    },
    move: (point: MeasurementPoint | null) => {
      const next = valid(point) ? { ...point } : null;
      const end = snapshot.start && !snapshot.complete ? next : snapshot.end;
      const hover = next?.snapped ? next : null;
      const same = (a: MeasurementPoint | null, b: MeasurementPoint | null) =>
        a?.x === b?.x &&
        a?.y === b?.y &&
        a?.z === b?.z &&
        a?.estimated === b?.estimated &&
        a?.snapped === b?.snapped;
      if (same(snapshot.end, end) && same(snapshot.hover, hover)) return;
      publish({ ...snapshot, end, hover });
    },
    place: (point: MeasurementPoint | null) => {
      if (!valid(point)) {
        if (snapshot.start && !snapshot.complete && snapshot.end)
          publish({ ...snapshot, end: null, hover: null });
        return;
      }
      if (!snapshot.start || snapshot.complete) {
        publish({
          start: { ...point },
          end: { ...point },
          complete: false,
          hover: point.snapped ? { ...point } : null,
        });
      } else if (measurementDistance(snapshot.start, point).distance > 1e-9) {
        publish({
          ...snapshot,
          end: { ...point },
          complete: true,
          hover: point.snapped ? { ...point } : null,
        });
      }
    },
    confirm: () => {
      if (
        snapshot.start &&
        snapshot.end &&
        !snapshot.complete &&
        measurementDistance(snapshot.start, snapshot.end).distance > 1e-9
      )
        publish({ ...snapshot, complete: true });
    },
  };
}
export type CanvasMeasurement = ReturnType<typeof createCanvasMeasurement>;
