import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { uid } from '../lib/circuit';
import {
  modelCadFromProject,
  withModelCad,
  type ModelCadObject,
  type ModelCadVector,
} from '../lib/model-cad';
import { parseProject, projectFromNativeFiles } from '../lib/project';
import { createEnclosureStep } from '../server/enclosure-step.mjs';

// Explicit offline OpenCASCADE export/import verification. No Electron or solver.
const require = createRequire(import.meta.url);
const { readNativeProject } = require('../electron/native-project.cjs');
const nativePath = path.resolve('project/emc-flyback/emc-flyback.kicad_pro');
const nativeFiles = await readNativeProject(nativePath);
const example = projectFromNativeFiles(nativeFiles);
assert.deepEqual(
  modelCadFromProject(example),
  modelCadFromProject(parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'))),
  'The actual native EMC settings must agree with the generated CAD fixture.',
);
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
  text = bytes.toString('ascii'),
  brepSolids = (text.match(/MANIFOLD_SOLID_BREP\(/g) || []).length,
  cylindricalSurfaces = (text.match(/CYLINDRICAL_SURFACE\(/g) || []).length;
assert.equal(
  brepSolids,
  2,
  'Overlapping independently editable objects must remain two manifold solids.',
);
assert.equal(
  cylindricalSurfaces,
  1,
  'The uncut cylindrical mount must retain one analytical cylindrical exterior.',
);
assert.equal(JSON.stringify(project.pcb), before);

const occt = await require('occt-import-js')();
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
type ImportedMesh = {
  attributes: { position: { array: number[] } };
  index: { array: number[] };
};
const importedMeshPoints = (mesh: ImportedMesh) => {
  const vertices = mesh.attributes.position.array;
  const points: ModelCadVector[] = [];
  for (let i = 0; i < vertices.length; i += 3)
    points.push({ x: vertices[i], y: vertices[i + 1], z: vertices[i + 2] });
  return points;
};
const importedMeshBounds = (mesh: ImportedMesh) => bounds(importedMeshPoints(mesh));
// Signed tetrahedra independently measure the imported closed shell. Bounds alone
// cannot distinguish drilled panels from solid rectangles with the same envelope.
const importedMeshVolume = (mesh: ImportedMesh) => {
  const points = importedMeshPoints(mesh),
    indices = mesh.index.array;
  let signed = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
    signed +=
      (a.x * (b.y * c.z - b.z * c.y) +
        a.y * (b.z * c.x - b.x * c.z) +
        a.z * (b.x * c.y - b.y * c.x)) /
      6;
  }
  return Math.abs(signed);
};
const matchingBounds = (actual: ReturnType<typeof bounds>, wanted: ReturnType<typeof bounds>) =>
  (['min', 'max'] as const).every((edge) =>
    (['x', 'y', 'z'] as const).every(
      (axis) => Math.abs(actual[edge][axis] - wanted[edge][axis]) < 0.011,
    ),
  );
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
  assert.equal(
    meshBounds.filter((actual: ReturnType<typeof bounds>) => matchingBounds(actual, wanted)).length,
    1,
    `Imported STEP geometry must match its independently transformed bounds: ${JSON.stringify(wanted)}`,
  );
}
// Export the Home example itself, including every independent panel
// and drilled feature, rather than replacing its CAD with the fixtures above.
assert.equal(Object.hasOwn(example.extensions, 'org.openpe.enclosure'), false);
const emcObjects = modelCadFromProject(example)!.objects;
assert.equal(emcObjects.length, 4);
const emcBefore = JSON.stringify(example.pcb);
const emcBytes = await createEnclosureStep(example);
const emcText = emcBytes.toString('ascii');
const emcBrepSolids = (emcText.match(/MANIFOLD_SOLID_BREP\(/g) || []).length,
  emcCylindricalSurfaces = (emcText.match(/CYLINDRICAL_SURFACE\(/g) || []).length;
assert.equal(emcBrepSolids, 4);
// OCC exports extruded sketch circles as analytical ellipse extrusions with
// equal radii, rather than the CYLINDRICAL_SURFACE used by cylinder primitives.
const emcEntities = new Map(
  [...emcText.matchAll(/#(\d+)\s*=\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
);
const emcCircularExtrusions = [
  ...emcText.matchAll(/SURFACE_OF_LINEAR_EXTRUSION\('',#(\d+),#\d+\)/g),
];
assert.equal(emcCircularExtrusions.length, 8);
for (const [, curve] of emcCircularExtrusions)
  assert.match(
    emcEntities.get(curve) ?? '',
    /^ELLIPSE\('',#\d+,1\.6,1\.6\)$/,
    'Every EMC cut wall must extrude an analytical circle of radius 1.6 mm.',
  );
assert.equal(JSON.stringify(example.pcb), emcBefore);
const emcImported = occt.ReadStepFile(emcBytes, {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.01,
  angularDeflection: 0.1,
});
assert.equal(emcImported.success, true, 'The current native EMC assembly must reimport as STEP.');
assert.equal(emcImported.meshes.length, 4);
const emcImportedBounds = emcImported.meshes.map(importedMeshBounds);
// Independent EMC dimensions: 112 x 94 x 3 mm panels, 30 mm walls,
// 8 mm floor clearance below the 1.6 mm board. Do not treat Boolean `size`
// (a conservative envelope) as the actual construction or use production bounds.
const emcExpectedBounds = [
  {
    name: 'Aluminium base',
    kind: 'boolean',
    min: { x: 44, y: 41, z: -11.8 },
    max: { x: 156, y: 135, z: -8.8 },
    holes: [
      { x: 53.8, y: 53.8 },
      { x: 146.2, y: 122.2 },
      { x: 146.2, y: 53.8 },
      { x: 53.8, y: 122.2 },
    ],
  },
  {
    name: 'Aluminium front wall',
    kind: 'box',
    min: { x: 44, y: 41, z: -8.8 },
    max: { x: 156, y: 44, z: 21.2 },
    holes: [],
  },
  {
    name: 'Aluminium back wall',
    kind: 'box',
    min: { x: 44, y: 132, z: -8.8 },
    max: { x: 156, y: 135, z: 21.2 },
    holes: [],
  },
  {
    name: 'Transparent cover',
    kind: 'boolean',
    min: { x: 44, y: 41, z: 21.2 },
    max: { x: 156, y: 135, z: 24.2 },
    holes: [
      { x: 52, y: 47 },
      { x: 52, y: 129 },
      { x: 148, y: 47 },
      { x: 148, y: 129 },
    ],
  },
];
const emcMeasurements = emcExpectedBounds.map((wanted) => {
  const saved = emcObjects.filter((object) => object.name === wanted.name);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, wanted.kind);
  assert.deepEqual(saved[0].rotation, { x: 0, y: 0, z: 0 });
  const matches: ImportedMesh[] = emcImported.meshes.filter((mesh: ImportedMesh) =>
    matchingBounds(importedMeshBounds(mesh), wanted),
  );
  assert.equal(
    matches.length,
    1,
    `${wanted.name}: one imported solid must match the independent world bounds.`,
  );
  const points = importedMeshPoints(matches[0]);
  for (const hole of wanted.holes)
    for (const z of [wanted.min.z, wanted.max.z])
      assert.ok(
        points.filter(
          (point) =>
            Math.abs(point.z - z) < 0.0001 &&
            Math.abs(Math.hypot(point.x - hole.x, point.y - hole.y) - 1.6) < 0.0001,
        ).length >= 16,
        `${wanted.name}: the 3.2 mm through cut at ${hole.x},${hole.y} must reach both faces.`,
      );
  const depth = wanted.max.z - wanted.min.z;
  const expectedVolume =
    (wanted.max.x - wanted.min.x) * (wanted.max.y - wanted.min.y) * depth -
    wanted.holes.length * Math.PI * 1.6 ** 2 * depth;
  const volume = importedMeshVolume(matches[0]);
  // Circle tessellation can add at most perimeter * chord deflection * depth.
  const tolerance = wanted.holes.length * 2 * Math.PI * 1.6 * 0.01 * depth + 0.001;
  assert.ok(
    Math.abs(volume - expectedVolume) < tolerance,
    `${wanted.name}: imported volume ${volume} must match analytical volume ${expectedVolume}.`,
  );
  return { name: wanted.name, volume, expectedVolume, tolerance, throughCuts: wanted.holes.length };
});
assert.deepEqual(
  await readNativeProject(nativePath),
  nativeFiles,
  'CAD verification preserves native files.',
);
// Publish only after every geometry check succeeds, in a fresh run directory.
// A failed rerun or write cannot replace earlier STEP files or summaries.
const evidenceRoot = 'test-results/model-cad';
await mkdir(evidenceRoot, { recursive: true });
const directory = await mkdtemp(path.join(evidenceRoot, 'run-'));
await writeFile(path.join(directory, 'model-cad.step'), bytes);
await writeFile(path.join(directory, 'emc-flyback-model-cad.step'), emcBytes);
const summary = {
  directory,
  source: path.relative(process.cwd(), nativePath),
  objects,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  brepSolids,
  cylindricalSurfaces,
  expectedBounds: expected,
  importedBounds: meshBounds,
  emc: {
    bytes: emcBytes.length,
    sha256: createHash('sha256').update(emcBytes).digest('hex'),
    brepSolids: emcBrepSolids,
    cylindricalSurfaces: emcCylindricalSurfaces,
    circularExtrusionSurfaces: emcCircularExtrusions.length,
    expectedBounds: emcExpectedBounds,
    importedBounds: emcImportedBounds,
    measurements: emcMeasurements,
  },
  engine: 'Pinned Gmsh OpenCASCADE export and independent occt-import-js reimport; no simulation',
};
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
