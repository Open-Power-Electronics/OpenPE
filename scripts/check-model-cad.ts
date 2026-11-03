import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { uid } from '../lib/circuit';
import {
  modelCadFromProject,
  withModelCad,
  type ModelCadObject,
  type ModelCadVector,
} from '../lib/model-cad';
import { parseProject } from '../lib/project';
import { createEnclosureStep } from '../server/enclosure-step.mjs';

// Explicit offline OpenCASCADE export/import verification. No Electron or solver.
const example = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
const project = withModelCad(example, null);
const objects: ModelCadObject[] = [
  {
    id: uid(),
    name: 'Rotated mounting block',
    kind: 'box',
    position: { x: 10, y: 20, z: 30 },
    rotation: { x: 17, y: 31, z: 43 },
    size: { x: 12, y: 8, z: 6 },
    material: 'aluminium',
    opacity: 1,
  },
  {
    id: uid(),
    name: 'Overlapping cylindrical mount',
    kind: 'cylinder',
    position: { x: 14, y: 20, z: 30 },
    rotation: { x: 90, y: 0, z: 0 },
    size: { x: 8, y: 8, z: 10 },
    material: 'plastic',
    opacity: 1,
  },
];
const target = withModelCad(project, { version: 1, objects }),
  before = JSON.stringify(project.pcb),
  bytes = await createEnclosureStep(target),
  text = bytes.toString('ascii');
assert.equal(
  (text.match(/MANIFOLD_SOLID_BREP\(/g) || []).length,
  2,
  'Overlapping independently editable objects must remain two manifold solids.',
);
assert.equal(
  (text.match(/CYLINDRICAL_SURFACE\(/g) || []).length,
  3,
  'The cylinder exterior and both requested local through cuts must remain analytical cylinders.',
);
assert.equal(JSON.stringify(project.pcb), before);

const occt = await createRequire(import.meta.url)('occt-import-js')();
const imported = occt.ReadStepFile(bytes, {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.01,
  angularDeflection: 0.1,
});
assert.equal(
  imported.success,
  true,
  'An independent OpenCASCADE importer must read the exported STEP.',
);
assert.equal(imported.meshes.length, 2);
const bounds = (points: ModelCadVector[]) => ({
  min: {
    x: Math.min(...points.map((p) => p.x)),
    y: Math.min(...points.map((p) => p.y)),
    z: Math.min(...points.map((p) => p.z)),
  },
  max: {
    x: Math.max(...points.map((p) => p.x)),
    y: Math.max(...points.map((p) => p.y)),
    z: Math.max(...points.map((p) => p.z)),
  },
});
const importedMeshBounds = (mesh: { attributes: { position: { array: number[] } } }) => {
  const vertices = mesh.attributes.position.array;
  const points: ModelCadVector[] = [];
  for (let i = 0; i < vertices.length; i += 3)
    points.push({ x: vertices[i], y: vertices[i + 1], z: vertices[i + 2] });
  return bounds(points);
};
const meshBounds = imported.meshes.map(importedMeshBounds);
// Independent closed-form Rx * Ry * Rz point transform checks compound rotation,
// world translation, centre-based primitives, and the STEP's millimetre scale.
const box = objects[0],
  radians = (angle: number) => (angle * Math.PI) / 180,
  [sx, sy, sz] = [box.rotation.x, box.rotation.y, box.rotation.z].map((a) => Math.sin(radians(a))),
  [cx, cy, cz] = [box.rotation.x, box.rotation.y, box.rotation.z].map((a) => Math.cos(radians(a)));
const corners: ModelCadVector[] = [];
for (const x of [-box.size.x / 2, box.size.x / 2])
  for (const y of [-box.size.y / 2, box.size.y / 2])
    for (const z of [-box.size.z / 2, box.size.z / 2]) {
      const zx = cz * x - sz * y,
        zy = sz * x + cz * y,
        yx = cy * zx + sy * z,
        yz = -sy * zx + cy * z;
      corners.push({
        x: yx + box.position.x,
        y: cx * zy - sx * yz + box.position.y,
        z: sx * zy + cx * yz + box.position.z,
      });
    }
const expected = [
  bounds(corners),
  {
    min: { x: 10, y: 15, z: 26 },
    max: { x: 18, y: 25, z: 34 },
  },
];
for (const wanted of expected) {
  assert.ok(
    meshBounds.some((actual: ReturnType<typeof bounds>) =>
      (['min', 'max'] as const).every((edge) =>
        (['x', 'y', 'z'] as const).every(
          (axis) => Math.abs(actual[edge][axis] - wanted[edge][axis]) < 0.011,
        ),
      ),
    ),
    `Imported STEP geometry must match its independently transformed bounds: ${JSON.stringify(wanted)}`,
  );
}
const directory = 'test-results/model-cad';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/model-cad.step`, bytes);
// Export the Home example itself, including every independent panel
// and drilled feature, rather than replacing its CAD with the fixtures above.
assert.equal(Object.hasOwn(example.extensions, 'org.openpe.enclosure'), false);
const emcObjects = modelCadFromProject(example)!.objects;
assert.equal(emcObjects.length, 4);
const emcBefore = JSON.stringify(example.pcb);
const emcBytes = await createEnclosureStep(example);
const emcText = emcBytes.toString('ascii');
assert.equal((emcText.match(/MANIFOLD_SOLID_BREP\(/g) || []).length, 4);
assert.equal((emcText.match(/CYLINDRICAL_SURFACE\(/g) || []).length, 8);
assert.equal(JSON.stringify(example.pcb), emcBefore);
const emcImported = occt.ReadStepFile(emcBytes, {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.01,
  angularDeflection: 0.1,
});
assert.equal(emcImported.success, true, 'The migrated EMC assembly must reimport as STEP.');
assert.equal(emcImported.meshes.length, 4);
const emcImportedBounds = emcImported.meshes.map(importedMeshBounds);
const emcExpectedBounds = emcObjects.map((object) => {
  assert.equal(object.kind, 'box');
  assert.deepEqual(object.rotation, { x: 0, y: 0, z: 0 });
  const min = { ...object.position },
    max = { ...object.position };
  for (const axis of ['x', 'y', 'z'] as const) {
    min[axis] -= object.size[axis] / 2;
    max[axis] += object.size[axis] / 2;
  }
  return { name: object.name, min, max };
});
for (const wanted of emcExpectedBounds)
  assert.equal(
    emcImportedBounds.filter((actual: ReturnType<typeof bounds>) =>
      (['min', 'max'] as const).every((edge) =>
        (['x', 'y', 'z'] as const).every(
          (axis) => Math.abs(actual[edge][axis] - wanted[edge][axis]) < 0.011,
        ),
      ),
    ).length,
    1,
    `${wanted.name}: one independently imported panel must match its saved world bounds.`,
  );
await writeFile(`${directory}/emc-flyback-model-cad.step`, emcBytes);
const summary = {
  objects,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  brepSolids: 2,
  cylindricalSurfaces: 3,
  expectedBounds: expected,
  importedBounds: meshBounds,
  combinedBrepSolids: 4,
  emc: {
    bytes: emcBytes.length,
    sha256: createHash('sha256').update(emcBytes).digest('hex'),
    brepSolids: 4,
    cylindricalSurfaces: 8,
    expectedBounds: emcExpectedBounds,
    importedBounds: emcImportedBounds,
  },
  engine: 'Pinned Gmsh OpenCASCADE export and independent occt-import-js reimport; no simulation',
};
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
