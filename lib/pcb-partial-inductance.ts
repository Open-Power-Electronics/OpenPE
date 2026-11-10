type Point3 = { x: number; y: number; z: number };

export type InductanceSegment = {
  start: Point3;
  end: Point3;
  radius: number;
};

const difference = (a: Point3, b: Point3): Point3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a: Point3, s: number): Point3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

function integrate(f: (x: number) => number, start: number, end: number) {
  if (start === end) return 0;
  const simpson = (width: number, left: number, middle: number, right: number) =>
    (width / 6) * (left + 4 * middle + right);
  function refine(
    a: number,
    b: number,
    left: number,
    middle: number,
    right: number,
    whole: number,
    tolerance: number,
    depth: number,
  ): number {
    const mid = (a + b) / 2;
    const q1 = f((a + mid) / 2);
    const q3 = f((mid + b) / 2);
    const low = simpson(mid - a, left, q1, middle);
    const high = simpson(b - mid, middle, q3, right);
    const delta = low + high - whole;
    if (Math.abs(delta) <= 15 * tolerance) return low + high + delta / 15;
    if (depth === 0 || !Number.isFinite(delta)) return NaN;
    return (
      refine(a, mid, left, q1, middle, low, tolerance / 2, depth - 1) +
      refine(mid, b, middle, q3, right, high, tolerance / 2, depth - 1)
    );
  }
  const left = f(start);
  const middle = f((start + end) / 2);
  const right = f(end);
  const whole = simpson(end - start, left, middle, right);
  return refine(start, end, left, middle, right, whole, 1e-8 + Math.abs(whole) * 1e-7, 16);
}

/** Regularized Neumann integral along a directed open copper route, in nH. */
export function routePartialInductanceNh(route: readonly InductanceSegment[]): number | null {
  const segments = route.map((segment) => {
    const span = difference(segment.end, segment.start);
    const length = Math.hypot(span.x, span.y, span.z);
    return { ...segment, length, direction: scale(span, 1 / length) };
  });
  let remaining = 1_000_000;
  let integral = 0;
  for (const [index, a] of segments.entries()) {
    integral +=
      2 *
      (a.length * Math.asinh(a.length / a.radius) -
        a.length ** 2 / (Math.hypot(a.length, a.radius) + a.radius));
    for (let j = 0; j < index; j++) {
      const b = segments[j];
      const alignment = dot(a.direction, b.direction);
      if (Math.abs(alignment) < 1e-12) continue;
      const delta = difference(a.start, b.start);
      const along = dot(delta, b.direction);
      const offset = difference(delta, scale(b.direction, along));
      const slope = difference(a.direction, scale(b.direction, alignment));
      const softening = (a.radius ** 2 + b.radius ** 2) / 2;
      // Integrate along b analytically and split a at its closest approach to
      // b's line so the numerical integration samples the narrowest separation.
      const inner = (s: number) => {
        if (--remaining < 0) return NaN;
        const separation = Math.sqrt(
          softening +
            (offset.x + s * slope.x) ** 2 +
            (offset.y + s * slope.y) ** 2 +
            (offset.z + s * slope.z) ** 2,
        );
        const projection = along + s * alignment;
        return (
          Math.asinh((b.length - projection) / separation) + Math.asinh(projection / separation)
        );
      };
      const slopeSquared = dot(slope, slope);
      const split =
        slopeSquared > 1e-24
          ? Math.min(a.length, Math.max(0, -dot(offset, slope) / slopeSquared))
          : 0;
      const mutual = integrate(inner, 0, split) + integrate(inner, split, a.length);
      if (!Number.isFinite(mutual)) return null;
      integral += 2 * alignment * mutual;
    }
  }
  // μ₀/(4π), with lengths in mm and output in nH.
  return Number.isFinite(integral) && integral > 0 ? 0.1 * integral : null;
}
