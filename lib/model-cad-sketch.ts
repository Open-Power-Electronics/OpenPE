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
      items: record({
        operation: { enum: ['union', 'difference', 'intersection'] },
        profile: modelCadProfileSchema,
        size: record({ x: quantity(0.5, 1000), y: quantity(0.5, 1000) }),
        position: record({ x: quantity(-100000, 100000), y: quantity(-100000, 100000) }),
      }),
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
    const profile = contour.profile;
    const points =
      profile.kind === 'circle'
        ? Array.from({ length: 128 }, (_, i) => ({
            x: (Math.cos((i * Math.PI) / 64) * contour.size.x) / 2,
            y: (Math.sin((i * Math.PI) / 64) * contour.size.y) / 2,
          }))
        : profile.kind === 'polygon'
          ? profile.points
          : [
              { x: -contour.size.x / 2, y: -contour.size.y / 2 },
              { x: contour.size.x / 2, y: -contour.size.y / 2 },
              { x: contour.size.x / 2, y: contour.size.y / 2 },
              { x: -contour.size.x / 2, y: contour.size.y / 2 },
            ];
    const clip = points.map((point) => ({
      X: Math.round((point.x + contour.position.x) * scale),
      Y: Math.round((point.y + contour.position.y) * scale),
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
