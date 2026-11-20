import { compileCapabilitySchema } from '../api/capability-schema';
import { uid } from './circuit';
import type { PCB } from './pcb';
import { pcbGraphicPoints } from './pcb-geometry';
import type { Project } from './project';

export const MODEL_CAD_EXTENSION = 'org.openpe.model-cad';
export const MODEL_CAD_NATIVE_VARIABLE = 'OPENPE_MODEL_CAD';
export type ModelCadVector = { x: number; y: number; z: number };
export type ModelCadPoint = { x: number; y: number };
export type ModelCadProfile =
  { kind: 'rectangle' } | { kind: 'circle' } | { kind: 'polygon'; points: ModelCadPoint[] };
type ModelCadEdgeTreatment = {
  kind: 'chamfer' | 'fillet';
  distanceMm: number;
  edges: string[];
};
export type ModelCadSelectableEdge =
  | { id: string; label: string; kind: 'line'; start: ModelCadVector; end: ModelCadVector }
  | { id: string; label: string; kind: 'circle'; center: ModelCadVector; radiusMm: number };
export type ModelCadBooleanOperation = 'union' | 'difference' | 'intersection';
export type ModelCadOperand = {
  shape: ModelCadShape;
  position: ModelCadVector;
  rotation: ModelCadVector;
};
type ModelCadBoolean = {
  operation: ModelCadBooleanOperation;
  operands: [ModelCadOperand, ModelCadOperand];
};
/** Geometry only; operand recipes never retain document IDs or presentation material. */
export type ModelCadShape = {
  kind: 'box' | 'cylinder' | 'extrusion' | 'boolean';
  size: ModelCadVector;
  profile?: ModelCadProfile;
  edgeTreatment?: ModelCadEdgeTreatment;
  boolean?: ModelCadBoolean;
};
export type ModelCadObject = {
  id: string;
  name: string;
  kind: ModelCadShape['kind'];
  /** Native PCB axes; Z is centred on the PCB thickness. */
  position: ModelCadVector;
  /** Intrinsic XYZ Euler angles in degrees, equivalent to Rx * Ry * Rz. */
  rotation: ModelCadVector;
  /** Centred local extents; extrusion Z is depth and Boolean extents are conservative. */
  size: ModelCadVector;
  material: 'aluminium' | 'pmma' | 'plastic';
  opacity: number;
  /** Optional RGB appearance override; absence uses the selected material color. */
  color?: string;
  profile?: ModelCadProfile;
  edgeTreatment?: ModelCadEdgeTreatment;
  boolean?: ModelCadBoolean;
};
export type ModelCAD = { version: 1; objects: ModelCadObject[] };
export const modelCadMaterialColors: Record<ModelCadObject['material'], number> = {
  aluminium: 0xbfc3c6,
  pmma: 0xdcecef,
  plastic: 0x777c82,
};
export function modelCadColor(object: Pick<ModelCadObject, 'material' | 'color'>): number {
  return object.color === undefined
    ? modelCadMaterialColors[object.material]
    : Number.parseInt(object.color.slice(1), 16);
}

const object = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const vector = (minimum: number, maximum: number) =>
  object({ x: number(minimum, maximum), y: number(minimum, maximum), z: number(minimum, maximum) });
const identity = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$',
};
export const modelCadProfileSchema = {
  oneOf: [
    object({ kind: { const: 'rectangle' } }),
    object({ kind: { const: 'circle' } }),
    object({
      kind: { const: 'polygon' },
      points: {
        type: 'array',
        minItems: 3,
        maxItems: 128,
        items: object({ x: number(-500, 500), y: number(-500, 500) }),
      },
    }),
  ],
};
const modelCadEdgeTreatmentSchema = object({
  kind: { enum: ['chamfer', 'fillet'] },
  distanceMm: number(0.01, 500),
  edges: {
    type: 'array',
    minItems: 1,
    maxItems: 448,
    uniqueItems: true,
    items: {
      type: 'string',
      maxLength: 32,
      pattern: '^(?:profile:(?:top|bottom):[0-9]{1,3}|side:[0-9]{1,3})$',
    },
  },
});
function shapeSchema(depth: number): Record<string, unknown> {
  const common = {
    size: vector(0.5, 1000),
    edgeTreatment: modelCadEdgeTreatmentSchema,
  };
  const alternatives: Record<string, unknown>[] = [
    object({ kind: { enum: ['box', 'cylinder'] }, ...common }, ['edgeTreatment']),
    object({ kind: { const: 'extrusion' }, ...common, profile: modelCadProfileSchema }, [
      'edgeTreatment',
    ]),
  ];
  if (depth <= 4)
    alternatives.push(
      object(
        {
          kind: { const: 'boolean' },
          ...common,
          boolean: object({
            operation: { enum: ['union', 'difference', 'intersection'] },
            operands: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: object({
                shape: shapeSchema(depth + 1),
                position: vector(-100000, 100000),
                rotation: vector(-360, 360),
              }),
            },
          }),
        },
        ['edgeTreatment'],
      ),
    );
  return { oneOf: alternatives };
}
const modelCadShapeSchema = shapeSchema(0);
export const modelCadObjectSchema = object(
  {
    id: identity,
    name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
    kind: { enum: ['box', 'cylinder', 'extrusion', 'boolean'] },
    position: vector(-100000, 100000),
    rotation: vector(-360, 360),
    size: vector(0.5, 1000),
    material: { enum: ['aluminium', 'pmma', 'plastic'] },
    opacity: number(0.05, 1),
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', minLength: 7, maxLength: 7 },
    profile: modelCadProfileSchema,
    edgeTreatment: modelCadEdgeTreatmentSchema,
    boolean: {
      type: 'object',
      properties: (modelCadShapeSchema.oneOf as Record<string, any>[])[2].properties.boolean
        .properties,
      required: ['operation', 'operands'],
      additionalProperties: false,
    },
  },
  ['profile', 'edgeTreatment', 'boolean', 'color'],
);
const modelCadSchema = object({
  version: { const: 1 },
  objects: { type: 'array', maxItems: 64, items: modelCadObjectSchema },
});
const checkObject = compileCapabilitySchema(modelCadObjectSchema);
const checkModel = compileCapabilitySchema(modelCadSchema);
const checkShape = compileCapabilitySchema(modelCadShapeSchema);
const checkProfile = compileCapabilitySchema(modelCadProfileSchema);
const fail = (message: string): never => {
  throw new Error(`Model CAD: ${message}`);
};

const epsilon = 1e-6;
type ProfileSize = Pick<ModelCadVector, 'x' | 'y'>;
type ModelCadBounds = { min: ModelCadVector; max: ModelCadVector };
const cross = (a: ModelCadPoint, b: ModelCadPoint, c: ModelCadPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const segmentDistance = (p: ModelCadPoint, a: ModelCadPoint, b: ModelCadPoint) => {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
function intersects(a: ModelCadPoint, b: ModelCadPoint, c: ModelCadPoint, d: ModelCadPoint) {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  return [
    [abC, c, a, b],
    [abD, d, a, b],
    [cdA, a, c, d],
    [cdB, b, c, d],
  ].some(([area, point, start, end]) =>
    Math.abs(area as number) <= epsilon
      ? segmentDistance(point as ModelCadPoint, start as ModelCadPoint, end as ModelCadPoint) <=
        epsilon
      : false,
  );
}
/** Closed profiles are local XY; polygon closure is implicit and its envelope is centred. */
export function validateModelCadProfile(input: unknown, size: ProfileSize): ModelCadProfile {
  const result = checkProfile(input);
  if (!result.valid) return fail(`Invalid profile: ${result.error}.`);
  if (![size.x, size.y].every((n) => Number.isFinite(n) && n >= 0.5 && n <= 1000))
    return fail('Profile dimensions must be between 0.5 and 1,000 mm.');
  const profile = input as ModelCadProfile;
  if (profile.kind === 'circle') {
    if (size.x !== size.y) return fail('A circular profile must have equal X and Y diameters.');
  } else if (profile.kind === 'polygon') {
    const { points } = profile;
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) <= epsilon)
        return fail(
          'Polygon profile edges must have positive length; do not repeat the closing point.',
        );
    }
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
      for (let j = i + 1; j < points.length; j++) {
        if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
        if (intersects(a, b, points[j], points[(j + 1) % points.length]))
          return fail('Polygon profiles cannot cross or touch themselves.');
      }
    }
    if (Math.abs(area) <= epsilon) return fail('A polygon profile must enclose positive area.');
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y),
      minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    if (Math.abs(minX + maxX) > epsilon || Math.abs(minY + maxY) > epsilon)
      return fail('Polygon profile bounds must be centred on the local origin.');
    if (Math.abs(maxX - minX - size.x) > epsilon || Math.abs(maxY - minY - size.y) > epsilon)
      return fail('Polygon profile bounds must match the extrusion X and Y dimensions.');
  }
  return profile;
}

function selectableEdges(shape: ModelCadShape): ModelCadSelectableEdge[] {
  if (shape.kind === 'boolean') return [];
  const edges: ModelCadSelectableEdge[] = [];
  const profile =
    shape.kind === 'extrusion'
      ? shape.profile!
      : shape.kind === 'cylinder'
        ? { kind: 'circle' as const }
        : { kind: 'rectangle' as const };
  const points: ModelCadPoint[] =
    profile.kind === 'polygon'
      ? profile.points
      : [
          { x: -shape.size.x / 2, y: -shape.size.y / 2 },
          { x: shape.size.x / 2, y: -shape.size.y / 2 },
          { x: shape.size.x / 2, y: shape.size.y / 2 },
          { x: -shape.size.x / 2, y: shape.size.y / 2 },
        ];
  for (const side of ['top', 'bottom'] as const) {
    const z = ((side === 'top' ? 1 : -1) * shape.size.z) / 2;
    const label = side === 'top' ? 'Top' : 'Bottom';
    if (profile.kind === 'circle')
      edges.push({
        id: `profile:${side}:0`,
        label: `${label} circular edge`,
        kind: 'circle',
        center: { x: 0, y: 0, z },
        radiusMm: shape.size.x / 2,
      });
    else
      for (let index = 0; index < points.length; index++)
        edges.push({
          id: `profile:${side}:${index}`,
          label: `${label} edge ${index + 1}`,
          kind: 'line',
          start: { ...points[index], z },
          end: { ...points[(index + 1) % points.length], z },
        });
  }
  if (profile.kind !== 'circle')
    for (let index = 0; index < points.length; index++)
      edges.push({
        id: `side:${index}`,
        label: `Vertical edge ${index + 1}`,
        kind: 'line',
        start: { ...points[index], z: -shape.size.z / 2 },
        end: { ...points[index], z: shape.size.z / 2 },
      });
  return edges;
}

/** Stable analytic base edges in local coordinates; existing treatment is replaced. */
export function modelCadSelectableEdges(input: ModelCadObject | ModelCadShape) {
  const shape = modelCadShape(input);
  delete shape.edgeTreatment;
  validateModelCadShape(shape);
  return selectableEdges(shape);
}

/** Structural/domain validation; advanced topology still requires the host kernel proof. */
export function validateModelCadShape(input: unknown): ModelCadShape {
  const result = checkShape(input);
  if (!result.valid) return fail(`Invalid shape: ${result.error}.`);
  let operations = 0;
  const visit = (shape: ModelCadShape, depth: number) => {
    if (shape.kind === 'cylinder' && shape.size.x !== shape.size.y)
      return fail('A cylinder must have equal X and Y diameters.');
    if (shape.kind === 'extrusion') validateModelCadProfile(shape.profile, shape.size);
    if (shape.edgeTreatment) {
      const treatment = shape.edgeTreatment;
      const selected = treatment.edges;
      const available = new Set(selectableEdges(shape).map((edge) => edge.id));
      if (selected.some((edge) => !available.has(edge)))
        return fail('A selected edge is unavailable on this base shape.');
      const d = treatment.distanceMm,
        count =
          Number(selected.some((edge) => edge.includes(':top:'))) +
          Number(selected.some((edge) => edge.includes(':bottom:')));
      if (
        count * d >= shape.size.z - epsilon ||
        2 * d >= Math.min(shape.size.x, shape.size.y) - epsilon
      )
        return fail('The edge treatment must leave positive body height and profile area.');
    }
    if (shape.kind === 'boolean') {
      if (depth > 4 || ++operations > 32)
        return fail('Boolean geometry exceeds the supported depth or operation count.');
      for (const operand of shape.boolean!.operands) visit(operand.shape, depth + 1);
      const bounds = booleanBounds(shape.boolean!);
      for (const axis of ['x', 'y', 'z'] as const)
        if (
          bounds.max[axis] <= bounds.min[axis] ||
          bounds.min[axis] < -shape.size[axis] / 2 - epsilon ||
          bounds.max[axis] > shape.size[axis] / 2 + epsilon
        )
          return fail('The Boolean envelope must contain its positive bounded result.');
    }
  };
  visit(input as ModelCadShape, 0);
  return input as ModelCadShape;
}

/** Independent ordered geometry; identity, top-level pose and material never enter the key. */
export function modelCadShape(body: ModelCadObject | ModelCadShape): ModelCadShape {
  const shape: ModelCadShape = {
    kind: body.kind,
    size: { x: body.size.x, y: body.size.y, z: body.size.z },
  };
  if (body.profile)
    shape.profile =
      body.profile.kind === 'polygon'
        ? { kind: 'polygon', points: body.profile.points.map(({ x, y }) => ({ x, y })) }
        : { kind: body.profile.kind };
  if (body.edgeTreatment)
    shape.edgeTreatment = {
      kind: body.edgeTreatment.kind,
      distanceMm: body.edgeTreatment.distanceMm,
      edges: [...body.edgeTreatment.edges],
    };
  if (body.boolean)
    shape.boolean = {
      operation: body.boolean.operation,
      operands: body.boolean.operands.map((operand) => ({
        shape: modelCadShape(operand.shape),
        position: { x: operand.position.x, y: operand.position.y, z: operand.position.z },
        rotation: { x: operand.rotation.x, y: operand.rotation.y, z: operand.rotation.z },
      })) as [ModelCadOperand, ModelCadOperand],
    };
  return shape;
}
export function modelCadGeometryKey(body: ModelCadObject | ModelCadShape): string {
  return JSON.stringify(modelCadShape(body));
}
export function modelCadRequiresPreparation(body: ModelCadObject | ModelCadShape): boolean {
  return body.kind === 'extrusion' || body.kind === 'boolean' || body.edgeTreatment !== undefined;
}

export function modelCadOperandBounds(operand: ModelCadOperand): ModelCadBounds {
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const radians = (n: number) => (n * Math.PI) / 180,
    [rx, ry, rz] = [operand.rotation.x, operand.rotation.y, operand.rotation.z].map(radians),
    [sx, sy, sz] = [rx, ry, rz].map(Math.sin),
    [cx, cy, cz] = [rx, ry, rz].map(Math.cos);
  for (const x of [-operand.shape.size.x / 2, operand.shape.size.x / 2])
    for (const y of [-operand.shape.size.y / 2, operand.shape.size.y / 2])
      for (const z of [-operand.shape.size.z / 2, operand.shape.size.z / 2]) {
        const zx = cz * x - sz * y,
          zy = sz * x + cz * y,
          yx = cy * zx + sy * z,
          yz = -sy * zx + cy * z,
          point = {
            x: yx + operand.position.x,
            y: cx * zy - sx * yz + operand.position.y,
            z: sx * zy + cx * yz + operand.position.z,
          };
        for (const axis of ['x', 'y', 'z'] as const) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
  return { min, max };
}
function booleanBounds(operation: ModelCadBoolean): ModelCadBounds {
  const [target, tool] = operation.operands.map(modelCadOperandBounds);
  if (operation.operation === 'difference') return target;
  const min = { ...target.min },
    max = { ...target.max };
  for (const axis of ['x', 'y', 'z'] as const) {
    min[axis] =
      operation.operation === 'union'
        ? Math.min(min[axis], tool.min[axis])
        : Math.max(min[axis], tool.min[axis]);
    max[axis] =
      operation.operation === 'union'
        ? Math.max(max[axis], tool.max[axis])
        : Math.min(max[axis], tool.max[axis]);
  }
  return { min, max };
}

export function newModelCadBooleanObject(
  target: ModelCadObject,
  tool: ModelCadObject,
  operation: ModelCadBooleanOperation,
  resultId = uid(),
): ModelCadObject {
  validateModelCadObject(target);
  validateModelCadObject(tool);
  if (target.id === tool.id) return fail('Choose two different bodies for a Boolean operation.');
  const operands: [ModelCadOperand, ModelCadOperand] = [target, tool].map((body) => ({
    shape: modelCadShape(body),
    position: { ...body.position },
    rotation: { ...body.rotation },
  })) as [ModelCadOperand, ModelCadOperand];
  const bounds = booleanBounds({ operation, operands });
  const position = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const size = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
  for (const operand of operands)
    for (const axis of ['x', 'y', 'z'] as const) operand.position[axis] -= position[axis];
  return validateModelCadObject({
    id: resultId,
    name: `${target.name.slice(0, 65)} ${operation}`,
    kind: 'boolean',
    position,
    rotation: { x: 0, y: 0, z: 0 },
    size,
    material: target.material,
    opacity: target.opacity,
    ...(target.color === undefined ? {} : { color: target.color }),
    boolean: { operation, operands },
  });
}

export function validateModelCadObject(input: unknown): ModelCadObject {
  const result = checkObject(input);
  if (!result.valid) return fail(`Invalid object: ${result.error}.`);
  const body = input as ModelCadObject;
  if (!body.name.trim()) return fail('An object name is required.');
  validateModelCadShape(modelCadShape(body));
  return body;
}

export function validateModelCad(input: unknown): ModelCAD {
  const result = checkModel(input);
  if (!result.valid) return fail(`Invalid model: ${result.error}.`);
  const model = input as ModelCAD;
  if (JSON.stringify(model).length > 256000)
    return fail('Model parameters exceed the supported 256,000-character native limit.');
  const identities = new Set<string>();
  for (const body of model.objects) {
    validateModelCadObject(body);
    if (identities.has(body.id.toLowerCase())) return fail('Object identities must be unique.');
    identities.add(body.id.toLowerCase());
  }
  return model;
}

export function modelCadFromProject(project: Project): ModelCAD | null {
  const input = project.extensions[MODEL_CAD_EXTENSION];
  return input === undefined ? null : validateModelCad(input);
}

export function modelCadBoardBounds(board: PCB) {
  const points = board.graphics.filter((g) => g.layer === 'Edge.Cuts').flatMap(pcbGraphicPoints);
  if (!points.length || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    throw new Error('A finite PCB outline is required.');
  const b = points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      maxX: Math.max(bounds.maxX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
  if (!(b.maxX > b.minX && b.maxY > b.minY)) throw new Error('A PCB outline area is required.');

  return b;
}

export function newModelCadObject(board: PCB, kind: ModelCadObject['kind']): ModelCadObject {
  if (kind === 'boolean') return fail('Create a Boolean result from two existing bodies.');
  let center = { x: 0, y: 0 };
  try {
    const b = modelCadBoardBounds(board);
    center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  } catch {
    if (board.footprints.length) {
      const xs = board.footprints.map((body) => body.x);
      const ys = board.footprints.map((body) => body.y);
      center = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      };
    }
  }
  return validateModelCadObject({
    id: uid(),
    name: kind === 'box' ? 'Box' : kind === 'cylinder' ? 'Cylinder' : 'Extrusion',
    kind,
    position: { ...center, z: board.thickness / 2 + 5 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: kind === 'cylinder' ? 6 : 20, y: kind === 'cylinder' ? 6 : 20, z: 10 },
    material: 'aluminium',
    opacity: 1,
    ...(kind === 'extrusion' ? { profile: { kind: 'rectangle' } } : {}),
  });
}

export function withModelCad(project: Project, input: ModelCAD | null): Project {
  if (!project.pcb) return fail('Open a PCB layout before editing Model CAD.');
  if (input) validateModelCad(input);
  if (JSON.stringify(project.extensions[MODEL_CAD_EXTENSION] ?? null) === JSON.stringify(input))
    return project;
  const extensions = { ...project.extensions };
  if (input) extensions[MODEL_CAD_EXTENSION] = input;
  else delete extensions[MODEL_CAD_EXTENSION];
  return { ...project, extensions };
}

export function nativeModelCadExtensions(
  previous: Project['extensions'],
  loaded: Project['extensions'],
) {
  const extensions = { ...previous };
  delete extensions[MODEL_CAD_EXTENSION];
  if (loaded[MODEL_CAD_EXTENSION] !== undefined)
    extensions[MODEL_CAD_EXTENSION] = loaded[MODEL_CAD_EXTENSION];
  return extensions;
}
