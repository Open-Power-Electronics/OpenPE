import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uid } from '../lib/circuit';
import {
  newModelCadBooleanObject,
  validateModelCadObject,
  type ModelCadObject,
  type ModelCadVector,
} from '../lib/model-cad';
import { modelCadStepGeometry, runModelCadStep } from '../server/model-cad-kernel.mjs';
import { emcAnalyticalModels } from './emc-flyback-analytical-models.mjs';

const root = fileURLToPath(
  new URL('../resources/example-catalog/footprints/emc-flyback/', import.meta.url),
);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const round = (value: number) => Number(value.toFixed(6));

type Vec3 = [number, number, number];
type BoxSpec = { name: string; size: Vec3; at: Vec3 };

// Footprint +Y is model −Y. T1 land centers below are already in that frame.
const recipes: Record<string, { boxes: BoxSpec[] }> = {
  'Bourns_SRN8040TA.step': {
    boxes: [
      { name: 'Shield', size: [8, 8, 4], at: [0, 0, 2] },
      { name: 'Terminal 1', size: [2.6, 8.2, 0.5], at: [-2.8, 0, 0.25] },
      { name: 'Terminal 2', size: [2.6, 8.2, 0.5], at: [2.8, 0, 0.25] },
    ],
  },
  'WE_750311591_EFD25-SMD_070-4476.step': {
    boxes: [
      { name: 'Envelope', size: [32.31, 27.03, 13.69], at: [0, 0, 6.845] },
      ...[
        [-15.19, 9.4],
        [-15.19, 5.64],
        [-15.19, 1.88],
        [-15.19, -1.88],
        [-15.19, -5.64],
        [-15.19, -9.4],
        [15.19, -9.4],
        [15.19, -5.64],
        [15.19, -1.88],
        [15.19, 1.88],
        [15.19, 5.64],
        [15.19, 9.4],
      ].map(([x, y], index) => ({
        name: `Terminal ${index + 1}`,
        size: [2.5, 1.52, 0.5] as Vec3,
        at: [x, y, 0.25] as Vec3,
      })),
    ],
  },
};

function vector(values: Vec3): ModelCadVector {
  return { x: values[0], y: values[1], z: values[2] };
}

function solid(boxes: BoxSpec[]) {
  const bodies = boxes.map((box) =>
    validateModelCadObject({
      id: uid(),
      name: box.name,
      kind: 'box',
      position: vector(box.at),
      rotation: { x: 0, y: 0, z: 0 },
      size: vector(box.size),
      material: 'plastic',
      opacity: 1,
    }),
  );
  let level = bodies;
  while (level.length > 1) {
    const next: ModelCadObject[] = [];
    for (let index = 0; index < level.length; index += 2)
      next.push(
        index + 1 === level.length
          ? level[index]
          : newModelCadBooleanObject(level[index], level[index + 1], 'union'),
      );
    level = next;
  }
  const [body] = level;
  if (!body) throw new Error('Analytical model has no solid.');
  return body;
}

export function analyticalBounds(boxes: BoxSpec[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], box.at[axis] - box.size[axis] / 2);
      max[axis] = Math.max(max[axis], box.at[axis] + box.size[axis] / 2);
    }
  return {
    min: min.map(round) as Vec3,
    max: max.map(round) as Vec3,
    center: min.map((value, axis) => round((value + max[axis]) / 2)) as Vec3,
  };
}

function exposedCorners(boxes: BoxSpec[]) {
  const corners: Vec3[] = [];
  for (const box of boxes)
    for (const x of [-1, 1])
      for (const y of [-1, 1])
        for (const z of [-1, 1]) {
          const point: Vec3 = [
            box.at[0] + (x * box.size[0]) / 2,
            box.at[1] + (y * box.size[1]) / 2,
            box.at[2] + (z * box.size[2]) / 2,
          ];
          const buried = boxes.some(
            (other) =>
              other !== box &&
              point.every(
                (value, axis) =>
                  value >= other.at[axis] - other.size[axis] / 2 - 1e-6 &&
                  value <= other.at[axis] + other.size[axis] / 2 + 1e-6,
              ),
          );
          if (!buried) corners.push(point.map(round) as Vec3);
        }
  return corners;
}

function normalizeStep(bytes: Buffer) {
  const text = bytes.toString('latin1');
  const split = text.indexOf('DATA;');
  if (split < 0) throw new Error('Analytical STEP has no DATA section.');
  const header = text.slice(0, split);
  const stamped = header.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?/g,
    '2000-01-01T00:00:00',
  );
  if (stamped === header) throw new Error('Analytical STEP header has no timestamp to pin.');
  return Buffer.from(stamped + text.slice(split), 'latin1');
}

async function stepBytes(body: ModelCadObject) {
  const first = normalizeStep(await runModelCadStep(modelCadStepGeometry(body)));
  const second = normalizeStep(await runModelCadStep(modelCadStepGeometry(body)));
  if (!first.equals(second))
    throw new Error('Analytical STEP generation is not reproducible.');
  return first;
}

async function meshPoints(bytes: Buffer) {
  const occt = await createRequire(import.meta.url)('occt-import-js')();
  const result = occt.ReadStepFile(new Uint8Array(bytes), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.003,
    angularDeflection: 0.5,
  });
  if (!result.success || !result.meshes?.length)
    throw new Error('The analytical STEP model could not be tessellated.');
  const points: Vec3[] = [];
  for (const mesh of result.meshes) {
    const values = mesh.attributes?.position?.array;
    if (!values) throw new Error('The analytical STEP mesh has no positions.');
    for (let index = 0; index < values.length; index += 3)
      points.push([values[index], values[index + 1], values[index + 2]]);
  }
  if (!points.length) throw new Error('The analytical STEP mesh is empty.');
  return points;
}

/** Board-frame check through the same tessellation settings as the model loader. */
export async function assertAnalyticalMesh(bytes: Buffer, replaces: string, offset: readonly number[]) {
  const recipe = recipes[replaces];
  if (!recipe) throw new Error(`No analytical recipe for ${replaces}.`);
  const bounds = analyticalBounds(recipe.boxes);
  const points = (await meshPoints(bytes)).map(
    (point) => point.map((value, axis) => value + offset[axis]) as Vec3,
  );
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(min[axis] - bounds.min[axis]) > 0.2 || Math.abs(max[axis] - bounds.max[axis]) > 0.2)
      throw new Error(
        `${replaces} bounds ${min.map((value) => value.toFixed(3))}..${max.map((value) => value.toFixed(3))} do not match ${bounds.min}..${bounds.max}.`,
      );
  }
  for (const corner of exposedCorners(recipe.boxes)) {
    const nearest = Math.min(
      ...points.map((point) =>
        Math.hypot(point[0] - corner[0], point[1] - corner[1], point[2] - corner[2]),
      ),
    );
    if (nearest > 0.25)
      throw new Error(`${replaces} is missing the corner ${corner.join(', ')} (${nearest} mm).`);
  }
}

function assertPlacement(body: ModelCadObject, offset: number[]) {
  const actual = [body.position.x, body.position.y, body.position.z].map(round);
  if (actual.some((value, index) => value !== offset[index]))
    throw new Error(
      `Analytical placement ${actual.join(', ')} does not match the manifest offset ${offset.join(', ')}.`,
    );
}

async function existing(file: string) {
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Analytical model ${file} must be a regular file.`);
  return readFile(file);
}

async function publish(file: string, bytes: Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function assertProvenance() {
  const license = JSON.parse(
    await readFile(path.join(root, 'manifest.json'), 'utf8'),
  ).licenses.find((entry: { file: string }) => entry.file === 'MODEL-SOURCES.md');
  const bytes = await readFile(path.join(root, 'MODEL-SOURCES.md'));
  const hash = digest(bytes);
  if (!license || license.sha256 !== hash)
    throw new Error(`MODEL-SOURCES.md is ${hash}; the manifest pin does not match.`);
}

export async function prepareEmcAnalyticalModels() {
  await assertProvenance();
  const models = emcAnalyticalModels();
  const replaced = new Set(Object.values(models).map((entry) => entry.replaces));
  if (replaced.size !== Object.keys(recipes).length || Object.keys(recipes).some((name) => !replaced.has(name)))
    throw new Error('The analytical manifest and generator recipes do not name the same models.');
  for (const [relative, entry] of Object.entries(models)) {
    const recipe = recipes[entry.replaces];
    if (
      !recipe ||
      relative !== `emc-flyback-demo/${path.basename(entry.file)}` ||
      entry.file !== `models/${path.basename(entry.file)}` ||
      !Array.isArray(entry.offset) ||
      entry.offset.length !== 3 ||
      !Array.isArray(entry.rotate) ||
      entry.rotate.some((value: number) => value !== 0) ||
      !Array.isArray(entry.scale) ||
      entry.scale.some((value: number) => value !== 1)
    )
      throw new Error(`Invalid analytical model pin: ${relative}`);
    const body = solid(recipe.boxes);
    assertPlacement(body, entry.offset);
    const file = path.join(root, entry.file);
    const present = await existing(file);
    const bytes = present ?? (await stepBytes(body));
    const hash = digest(bytes);
    if (hash !== entry.sha256 || bytes.length !== entry.size)
      throw new Error(
        `Analytical STEP ${entry.file} is ${hash} (${bytes.length} bytes); manifest pins ${entry.sha256} (${entry.size}). The existing file was preserved.`,
      );
    await assertAnalyticalMesh(bytes, entry.replaces, entry.offset);
    if (!present) await publish(file, bytes);
    console.log(`${entry.file}: analytical STEP ${bytes.length} bytes.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareEmcAnalyticalModels();
