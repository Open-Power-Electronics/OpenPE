type Point3 = { x: number; y: number; z: number };
export type ModelCameraBounds = { center: Point3; radius: number };

const finitePoint = (point: Point3) => [point.x, point.y, point.z].every(Number.isFinite);
const minimumNear = 0.001;

/** Tight camera-space depth bounds preserve the PCB's closely spaced surfaces.
 * The sphere is presentation geometry, independent of the orbit target after pan.
 */
export function modelCameraClipping({
  position,
  target,
  bounds,
}: {
  position: Point3;
  target: Point3;
  bounds?: ModelCameraBounds | null;
}): { near: number; far: number } {
  const eye = finitePoint(position) ? position : { x: 0, y: 0, z: 0 };
  const focus = finitePoint(target) ? target : { x: eye.x, y: eye.y, z: eye.z - 1 };
  const dx = focus.x - eye.x,
    dy = focus.y - eye.y,
    dz = focus.z - eye.z;
  const distance = Math.hypot(dx, dy, dz);
  const direction =
    Number.isFinite(distance) && distance > 0
      ? { x: dx / distance, y: dy / distance, z: dz / distance }
      : { x: 0, y: 0, z: -1 };
  const validBounds =
    bounds && finitePoint(bounds.center) && Number.isFinite(bounds.radius) && bounds.radius >= 0;
  const sphere = validBounds
    ? bounds
    : {
        center: focus,
        radius: Math.max(1, Number.isFinite(distance) ? distance / 2 : 1),
      };
  const depth =
    (sphere.center.x - eye.x) * direction.x +
    (sphere.center.y - eye.y) * direction.y +
    (sphere.center.z - eye.z) * direction.z;
  // Padding keeps boundary faces away from clipping planes. When the camera
  // enters the sphere, retain nearby visible geometry rather than clipping it
  // merely to improve precision. Empty/invalid views still get finite planes.
  const padding = Math.max(0.05, sphere.radius * 0.02);
  const near = Math.max(minimumNear, depth - sphere.radius - padding);
  const far = Math.max(near + 0.1, depth + sphere.radius + padding);
  return Number.isFinite(near) && Number.isFinite(far)
    ? { near, far }
    : { near: minimumNear, far: 10 };
}
