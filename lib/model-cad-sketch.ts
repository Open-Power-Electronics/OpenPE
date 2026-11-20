import Clipper from 'clipper-lib';
import { compileCapabilitySchema } from '../api/capability-schema';
import {
  modelCadObjectSchema,
  modelCadProfileSchema,
  newModelCadBooleanObject,
  validateModelCadObject,
  validateModelCadProfile,
  type ModelCadBooleanOperation,
  type ModelCadObject,
  type ModelCadPoint,
  type ModelCadProfile,
  type ModelCadVector,
} from './model-cad';

export type ModelCadSketchContour = {
  operation: ModelCadBooleanOperation;
  profile: ModelCadProfile;
  size: { x: number; y: number };
  position: ModelCadPoint;
  cornerTreatment?: ModelCadSketchCornerTreatment;
};
type ModelCadSketchCornerTreatment = {
  kind: 'fillet' | 'chamfer';
  distanceMm: number;
  corners: number[];
};
export type ModelCadSketchExtrusion = {
  id: string;
  name: string;
  plane: 'XY' | 'XZ' | 'YZ';
  origin: ModelCadVector;
  contours: ModelCadSketchContour[];
  distance: number;
  direction: 'positive' | 'negative' | 'symmetric';
  material: ModelCadObject['material'];
  opacity: number;
  color?: string;
};
const record = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const quantity = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const fields = modelCadObjectSchema.properties;
const cornerTreatmentSchema = record({
  kind: { enum: ['fillet', 'chamfer'] },
  distanceMm: quantity(0.01, 500),
  corners: {
    type: 'array',
    minItems: 1,
    maxItems: 128,
    uniqueItems: true,
    items: { type: 'integer', minimum: 0, maximum: 127 },
  },
});
const checkCorners = compileCapabilitySchema(cornerTreatmentSchema);
export const modelCadSketchExtrusionSchema = record(
  {
    id: fields.id,
    name: fields.name,
    plane: { enum: ['XY', 'XZ', 'YZ'] },
    origin: fields.position,
    contours: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: record(
        {
          operation: { enum: ['union', 'difference', 'intersection'] },
          profile: modelCadProfileSchema,
          size: record({ x: quantity(0.5, 1000), y: quantity(0.5, 1000) }),
          position: record({ x: quantity(-100000, 100000), y: quantity(-100000, 100000) }),
          cornerTreatment: cornerTreatmentSchema,
        },
        ['cornerTreatment'],
      ),
    },
    distance: quantity(0.5, 1000),
    direction: { enum: ['positive', 'negative', 'symmetric'] },
    material: fields.material,
    opacity: fields.opacity,
    color: fields.color,
  },
  ['color'],
);
const checkExtrusion = compileCapabilitySchema(modelCadSketchExtrusionSchema);

/** A closed sketch contour retains analytic circles and exact polygon vertices. */
export function prepareModelCadSketchContour(
  shape: ModelCadProfile['kind'],
  points: readonly ModelCadPoint[],
  operation: ModelCadBooleanOperation = 'union',
): ModelCadSketchContour {
  if (
    points.length < (shape === 'polygon' ? 3 : 2) ||
    points.length > 128 ||
    points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  )
    throw new Error('Draw a closed sketch contour.');
  let position: ModelCadPoint;
  let size: { x: number; y: number };
  if (shape === 'circle') {
    position = { ...points[0] };
    const diameter = 2 * Math.hypot(points[1].x - position.x, points[1].y - position.y);
    size = { x: diameter, y: diameter };
  } else {
    const xs = points.map((point) => point.x),
      ys = points.map((point) => point.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    position = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    size = { x: maxX - minX, y: maxY - minY };
  }
  const profile: ModelCadProfile =
    shape === 'polygon'
      ? {
          kind: shape,
          points: points.map((point) => ({ x: point.x - position.x, y: point.y - position.y })),
        }
      : { kind: shape };
  validateModelCadProfile(profile, size);
  return { operation, profile, size, position };
}

/** Base vertices keep their native indices, including after a corner operation. */
export function modelCadSketchVertices(contour: ModelCadSketchContour): ModelCadPoint[] {
  if (contour.profile.kind === 'circle') return [];
  return contour.profile.kind === 'polygon'
    ? contour.profile.points.map((point) => ({ ...point }))
    : [
        { x: -contour.size.x / 2, y: -contour.size.y / 2 },
        { x: contour.size.x / 2, y: -contour.size.y / 2 },
        { x: contour.size.x / 2, y: contour.size.y / 2 },
        { x: -contour.size.x / 2, y: contour.size.y / 2 },
      ];
}

function cornerGeometry(contour: ModelCadSketchContour) {
  const points = modelCadSketchVertices(contour);
  const treatment = contour.cornerTreatment;
  if (!treatment)
    return points.map((point) => ({
      start: point,
      end: point,
      trim: 0,
      center: null as ModelCadPoint | null,
      sweep: 0,
    }));
  const checked = checkCorners(treatment);
  if (!checked.valid) throw new Error(`Invalid sketch corner treatment: ${checked.error}.`);
  if (!points.length) throw new Error('Circles have no corners to fillet or chamfer.');
  if (treatment.corners.some((index) => index >= points.length))
    throw new Error('A selected sketch corner is unavailable.');
  if (2 * treatment.distanceMm >= Math.min(contour.size.x, contour.size.y) - 1e-6)
    throw new Error('The corner treatment must leave positive profile area.');
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const orientation = Math.sign(area);
  const selected = new Set(treatment.corners);
  const corners = points.map((point, index) => {
    if (!selected.has(index))
      return { start: point, end: point, trim: 0, center: null as ModelCadPoint | null, sweep: 0 };
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const a = Math.hypot(previous.x - point.x, previous.y - point.y);
    const b = Math.hypot(next.x - point.x, next.y - point.y);
    const u = { x: (previous.x - point.x) / a, y: (previous.y - point.y) / a };
    const v = { x: (next.x - point.x) / b, y: (next.y - point.y) / b };
    if ((v.x * u.y - v.y * u.x) * orientation <= 1e-6)
      throw new Error('Choose convex, non-collinear sketch corners.');
    const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
    const trim =
      treatment.kind === 'fillet'
        ? treatment.distanceMm / Math.tan(angle / 2)
        : treatment.distanceMm;
    const start = { x: point.x + u.x * trim, y: point.y + u.y * trim };
    const end = { x: point.x + v.x * trim, y: point.y + v.y * trim };
    const bisector = Math.hypot(u.x + v.x, u.y + v.y);
    const offset = treatment.distanceMm / Math.sin(angle / 2);
    const center =
      treatment.kind === 'fillet'
        ? {
            x: point.x + ((u.x + v.x) / bisector) * offset,
            y: point.y + ((u.y + v.y) / bisector) * offset,
          }
        : null;
    return { start, end, trim, center, sweep: orientation * (Math.PI - angle) };
  });
  for (let index = 0; index < points.length; index++) {
    const next = (index + 1) % points.length;
    if (
      corners[index].trim + corners[next].trim >=
      Math.hypot(points[index].x - points[next].x, points[index].y - points[next].y) - 1e-6
    )
      throw new Error(
        'Corner treatments overlap along a sketch edge. Reduce the radius or distance.',
      );
  }
  return corners;
}

/** Shared GUI/Agent corner preparation; native solids retain analytical vertical-edge treatments. */
export function prepareModelCadSketchCorners(
  contour: ModelCadSketchContour,
  treatment: ModelCadSketchCornerTreatment | null,
): ModelCadSketchContour {
  validateModelCadProfile(contour.profile, contour.size);
  const next = structuredClone(contour);
  if (treatment) next.cornerTreatment = structuredClone(treatment);
  else delete next.cornerTreatment;
  cornerGeometry(next);
  return next;
}

/** Tessellation is for sketch display only; arc samples never replace accepted circle/fillet geometry. */
export function modelCadSketchContourOutline(contour: ModelCadSketchContour): ModelCadPoint[] {
  const local =
    contour.profile.kind === 'circle'
      ? Array.from({ length: 128 }, (_, i) => ({
          x: (Math.cos((i * Math.PI) / 64) * contour.size.x) / 2,
          y: (Math.sin((i * Math.PI) / 64) * contour.size.y) / 2,
        }))
      : cornerGeometry(contour).flatMap(({ start, end, center, sweep }) => {
          if (!center) return start === end ? [start] : [start, end];
          const angle = Math.atan2(start.y - center.y, start.x - center.x);
          const radius = Math.hypot(start.x - center.x, start.y - center.y);
          const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
          return Array.from({ length: segments + 1 }, (_, index) => ({
            x: center.x + radius * Math.cos(angle + (sweep * index) / segments),
            y: center.y + radius * Math.sin(angle + (sweep * index) / segments),
          }));
        });
  return local.map((point) => ({
    x: point.x + contour.position.x,
    y: point.y + contour.position.y,
  }));
}

/** Presentation picking: original indexed corners first, then displayed contour edges/interiors. */
export function pickModelCadSketchContour(
  contours: readonly ModelCadSketchContour[],
  point: ModelCadPoint,
  tolerance: number,
): { contour: number; corner?: number } | null {
  if (![point.x, point.y, tolerance].every(Number.isFinite) || tolerance < 0) return null;
  let picked: { contour: number; corner?: number } | null = null;
  let nearest = tolerance;
  for (let index = contours.length - 1; index >= 0; index--)
    for (const [corner, vertex] of modelCadSketchVertices(contours[index]).entries()) {
      const distance = Math.hypot(
        vertex.x + contours[index].position.x - point.x,
        vertex.y + contours[index].position.y - point.y,
      );
      if (distance <= nearest) {
        nearest = distance;
        picked = { contour: index, corner };
      }
    }
  if (picked) return picked;
  let inside: number | null = null;
  for (let index = contours.length - 1; index >= 0; index--) {
    const outline = modelCadSketchContourOutline(contours[index]);
    let contains = false;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i],
        b = outline[(i + 1) % outline.length];
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const length2 = dx * dx + dy * dy;
      const t = length2
        ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2))
        : 0;
      const distance = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
      if (distance <= nearest) {
        nearest = distance;
        picked = { contour: index };
      }
      if (
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      )
        contains = !contains;
    }
    if (contains && inside === null) inside = index;
  }
  return picked ?? (inside === null ? null : { contour: inside });
}

/** Extrusion distributes over planar Booleans; every operand shares depth and workplane. */
export function extrudeModelCadSketch(input: unknown): ModelCadObject {
  const checked = checkExtrusion(input);
  if (!checked.valid) throw new Error(`Invalid sketch extrusion: ${checked.error}.`);
  const sketch = structuredClone(input) as ModelCadSketchExtrusion;
  if (sketch.contours[0].operation !== 'union')
    throw new Error('The first sketch contour must start the region with Union.');
  const toolId =
    sketch.id.slice(0, -1) + ((parseInt(sketch.id.slice(-1), 16) + 1) % 16).toString(16);
  let result: ModelCadObject | null = null;
  for (const contour of sketch.contours) {
    validateModelCadProfile(contour.profile, contour.size);
    if (contour.cornerTreatment) prepareModelCadSketchCorners(contour, contour.cornerTreatment);
    const body = validateModelCadObject({
      id: result ? toolId : sketch.id,
      name: sketch.name,
      kind: 'extrusion',
      profile: contour.profile,
      size: { ...contour.size, z: sketch.distance },
      position: { ...contour.position, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      material: sketch.material,
      opacity: sketch.opacity,
      ...(contour.cornerTreatment
        ? {
            edgeTreatment: {
              kind: contour.cornerTreatment.kind,
              distanceMm: contour.cornerTreatment.distanceMm,
              edges: contour.cornerTreatment.corners.map((index) => `side:${index}`),
            },
          }
        : {}),
      ...(sketch.color === undefined ? {} : { color: sketch.color }),
    });
    result = result ? newModelCadBooleanObject(result, body, contour.operation, sketch.id) : body;
  }
  const offset =
    sketch.direction === 'symmetric'
      ? 0
      : sketch.distance * (sketch.direction === 'positive' ? 0.5 : -0.5);
  const { x, y } = result!.position;
  return validateModelCadObject({
    ...result!,
    name: sketch.name,
    position:
      sketch.plane === 'XY'
        ? { x: sketch.origin.x + x, y: sketch.origin.y + y, z: sketch.origin.z + offset }
        : sketch.plane === 'XZ'
          ? { x: sketch.origin.x + x, y: sketch.origin.y - offset, z: sketch.origin.z + y }
          : { x: sketch.origin.x + offset, y: sketch.origin.y + x, z: sketch.origin.z + y },
    rotation:
      sketch.plane === 'XY'
        ? { x: 0, y: 0, z: 0 }
        : sketch.plane === 'XZ'
          ? { x: 90, y: 0, z: 0 }
          : { x: 90, y: 90, z: 0 },
  });
}

/** Bounded display tessellation only; accepted geometry keeps analytic contour recipes. */
export function modelCadSketchOutlines(
  contours: readonly ModelCadSketchContour[],
): ModelCadPoint[][] {
  const scale = 10000;
  let paths: Clipper.Paths = [];
  for (const contour of contours) {
    const points = modelCadSketchContourOutline(contour);
    const clip = points.map((point) => ({
      X: Math.round(point.x * scale),
      Y: Math.round(point.y * scale),
    }));
    if (!Clipper.Clipper.Orientation(clip)) clip.reverse();
    if (!paths.length && contour === contours[0]) {
      paths = [clip];
      continue;
    }
    const engine = new Clipper.Clipper();
    engine.AddPaths(paths, Clipper.PolyType.ptSubject, true);
    engine.AddPath(clip, Clipper.PolyType.ptClip, true);
    const next: Clipper.Paths = [];
    engine.Execute(
      {
        union: Clipper.ClipType.ctUnion,
        difference: Clipper.ClipType.ctDifference,
        intersection: Clipper.ClipType.ctIntersection,
      }[contour.operation],
      next,
      Clipper.PolyFillType.pftNonZero,
      Clipper.PolyFillType.pftNonZero,
    );
    paths = next;
  }
  return paths.map((path) => path.map((point) => ({ x: point.X / scale, y: point.Y / scale })));
}
