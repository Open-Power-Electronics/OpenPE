import { pinPositions, snap, type Circuit, type Part, type Point } from './circuit';
import { unitGraphics } from './library';
import { child, children, val, type SExpr } from './sexpr';

/** Visible terminal geometry with original pin indexes retained for probing. */
export function visibleSchematicPins(
  part: Part,
  library: SExpr,
): { point: Point; index: number }[] {
  const positions = pinPositions(part, library),
    definitions = unitGraphics(library, part.unit || 1).flatMap((group) => children(group, 'pin'));
  return definitions.flatMap((pin, index) =>
    pin.includes('hide') || val(child(pin, 'hide')) === 'yes'
      ? []
      : [{ point: positions[index], index }],
  );
}

function validateTarget(raw: Point, tolerance: number) {
  if (![raw.x, raw.y].every(Number.isFinite))
    throw new Error('Wire target coordinates must be finite.');
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error('Wire snapping tolerance must be a finite, nonnegative distance.');
}

/** Snapshot visible geometry once; pointer updates do not rebuild transformed pins. */
export function createSchematicWireTargetResolver(doc: Circuit, visibleIds: ReadonlySet<string>) {
  const anchors: Point[] = [];
  const copyAnchor = (point: Point) => anchors.push({ x: point.x, y: point.y });
  for (const part of doc.parts) {
    if (!visibleIds.has(part.id)) continue;
    for (const { point } of visibleSchematicPins(part, doc.libraries[part.libId]))
      copyAnchor(point);
  }
  const wires = doc.wires
    .filter((wire) => visibleIds.has(wire.id))
    .map((wire) => {
      copyAnchor(wire.a);
      copyAnchor(wire.b);
      const dx = wire.b.x - wire.a.x,
        dy = wire.b.y - wire.a.y;
      return {
        a: { x: wire.a.x, y: wire.a.y },
        dx,
        dy,
        length: dx * dx + dy * dy,
        minX: Math.min(wire.a.x, wire.b.x),
        maxX: Math.max(wire.a.x, wire.b.x),
        minY: Math.min(wire.a.y, wire.b.y),
        maxY: Math.max(wire.a.y, wire.b.y),
        // Floating-point projection at t=1 may land just beyond native b.
        // Include that computed endpoint without altering native axis snapping.
        searchMinX: Math.min(wire.a.x, wire.b.x, wire.a.x + dx),
        searchMaxX: Math.max(wire.a.x, wire.b.x, wire.a.x + dx),
        searchMinY: Math.min(wire.a.y, wire.b.y, wire.a.y + dy),
        searchMaxY: Math.max(wire.a.y, wire.b.y, wire.a.y + dy),
      };
    });
  for (const point of [...doc.labels, ...doc.junctions])
    if (visibleIds.has(point.id)) copyAnchor(point);

  return (raw: Point, tolerance: number, magnetic = true): Point => {
    validateTarget(raw, tolerance);
    // Shift temporarily disables connected-object snapping, retaining the
    // schematic grid and exact geometric connections at the resulting point.
    if (!magnetic) return { x: snap(raw.x), y: snap(raw.y) };
    const nearest: { point: Point | null; distance: number; anchor: boolean } = {
      point: null,
      distance: Infinity,
      anchor: false,
    };
    const consider = (point: Point, distance: number, anchor: boolean) => {
      if (distance > tolerance) return;
      const difference = distance - nearest.distance;
      if (difference < -1e-9 || (Math.abs(difference) <= 1e-9 && anchor && !nearest.anchor)) {
        nearest.point = { x: point.x, y: point.y };
        nearest.distance = distance;
        nearest.anchor = anchor;
      }
    };
    // Reject distant geometry before exact distances/projections. The box is
    // conservative: ranking, inclusive tolerance and native targets stay exact.
    for (const point of anchors) {
      const dx = raw.x - point.x,
        dy = raw.y - point.y;
      if (Math.abs(dx) > tolerance || Math.abs(dy) > tolerance) continue;
      consider(point, Math.hypot(dx, dy), true);
    }
    for (const wire of wires) {
      const { dx, dy, length, minX, maxX, minY, maxY } = wire;
      if (
        !length ||
        wire.searchMinX - raw.x > tolerance ||
        raw.x - wire.searchMaxX > tolerance ||
        wire.searchMinY - raw.y > tolerance ||
        raw.y - wire.searchMaxY > tolerance
      )
        continue;
      const t = Math.max(
          0,
          Math.min(1, ((raw.x - wire.a.x) * dx + (raw.y - wire.a.y) * dy) / length),
        ),
        projection =
          dy === 0
            ? {
                x: Math.max(minX, Math.min(maxX, raw.x)),
                y: wire.a.y,
              }
            : dx === 0
              ? {
                  x: wire.a.x,
                  y: Math.max(minY, Math.min(maxY, raw.y)),
                }
              : { x: wire.a.x + t * dx, y: wire.a.y + t * dy },
        distance = Math.hypot(raw.x - projection.x, raw.y - projection.y),
        target = { ...projection };
      // Eligibility/ranking follows distance to the wire, while tangential snapping
      // follows the grid. Native off-grid constant coordinates remain authoritative.
      if (dy === 0) {
        const x = snap(raw.x);
        if (x >= minX && x <= maxX) target.x = x;
        target.y = wire.a.y;
      } else if (dx === 0) {
        const y = snap(raw.y);
        if (y >= minY && y <= maxY) target.y = y;
        target.x = wire.a.x;
      }
      consider(target, distance, false);
    }
    return nearest.point ?? { x: snap(raw.x), y: snap(raw.y) };
  };
}

/** Resolve wire placement against visible native geometry before the fixed grid. */
export function snapSchematicWireTarget(
  doc: Circuit,
  visibleIds: ReadonlySet<string>,
  raw: Point,
  tolerance: number,
  magnetic = true,
): Point {
  validateTarget(raw, tolerance);
  if (!magnetic) return { x: snap(raw.x), y: snap(raw.y) };
  return createSchematicWireTargetResolver(doc, visibleIds)(raw, tolerance);
}
