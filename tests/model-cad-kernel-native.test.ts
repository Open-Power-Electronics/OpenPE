import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { uid } from '../lib/circuit';
import {
  modelCadShape,
  withModelCad,
  type ModelCadObject,
  type ModelCadVector,
} from '../lib/model-cad';
import { parseProject } from '../lib/project';
import { createEnclosureStep } from '../server/enclosure-step.mjs';
import { createModelCadPreviewService, modelCadStepGeometry } from '../server/model-cad-kernel.mjs';

type Mesh = { attributes: { position: { array: number[] } }; index: { array: number[] } };
const body = (name: string): ModelCadObject => ({
  id: uid(),
  name,
  kind: 'extrusion',
  position: { x: 30, y: 20, z: 18 },
  rotation: { x: 17, y: 31, z: 43 },
  size: { x: 20, y: 16, z: 8 },
  material: 'aluminium',
  opacity: 1,
  holes: [],
  profile: { kind: 'rectangle' },
});
const measure = (meshes: Mesh[], pose?: ModelCadObject) => {
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let volume = 0,
    triangles = 0;
  const transform = (p: ModelCadVector) => {
    if (!pose) return p;
    const radians = Math.PI / 180;
    const [sx, sy, sz] = [pose.rotation.x, pose.rotation.y, pose.rotation.z].map((a) =>
      Math.sin(a * radians),
    );
    const [cx, cy, cz] = [pose.rotation.x, pose.rotation.y, pose.rotation.z].map((a) =>
      Math.cos(a * radians),
    );
    const zx = cz * p.x - sz * p.y,
      zy = sz * p.x + cz * p.y;
    const yx = cy * zx + sy * p.z,
      yz = -sy * zx + cy * p.z;
    return {
      x: yx + pose.position.x,
      y: cx * zy - sx * yz + pose.position.y,
      z: sx * zy + cx * yz + pose.position.z,
    };
  };
  for (const mesh of meshes) {
    const raw = mesh.attributes.position.array,
      indices = mesh.index.array;
    const points: ModelCadVector[] = [];
    for (let i = 0; i < raw.length; i += 3) {
      const point = transform({ x: raw[i], y: raw[i + 1], z: raw[i + 2] });
      points.push(point);
      for (const axis of ['x', 'y', 'z'] as const) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
    let signed = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]];
      signed +=
        (a.x * (b.y * c.z - b.z * c.y) +
          a.y * (b.z * c.x - b.x * c.z) +
          a.z * (b.x * c.y - b.y * c.x)) /
        6;
      triangles++;
    }
    volume += Math.abs(signed);
  }
  return { min, max, volume, triangles, solids: meshes.length };
};

test(
  'native selected edges retain unrelated corners and agree between preview and STEP',
  { skip: process.env.OPENPE_TEST_MODEL_CAD !== '1', timeout: 120_000 },
  async () => {
    const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
    const base: ModelCadObject = {
      ...body('selected-edge-base'),
      kind: 'box',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      size: { x: 20, y: 16, z: 8 },
      holes: [],
    };
    delete base.profile;
    const occt = await createRequire(import.meta.url)('occt-import-js')();
    const service = createModelCadPreviewService();
    try {
      for (const [id, kind, length] of [
        ['side:0', 'fillet', 8],
        ['profile:top:0', 'fillet', 20],
        ['side:2', 'chamfer', 8],
      ] as const) {
        const target: ModelCadObject = {
          ...base,
          edgeTreatment: { kind, distanceMm: 0.5, edges: [id] },
        };
        const preview = await service.preview(target);
        const local = measure(preview.meshes);
        const bytes = await createEnclosureStep(
          withModelCad(project, { version: 1, objects: [target] }),
        );
        const imported = occt.ReadStepFile(bytes, {
          linearUnit: 'millimeter',
          linearDeflectionType: 'absolute_value',
          linearDeflection: 0.002,
          angularDeflection: 0.1,
        });
        assert.equal(imported.success, true);
        const exported = measure(imported.meshes);
        const expected =
          20 * 16 * 8 - length * 0.5 ** 2 * (kind === 'fillet' ? 1 - Math.PI / 4 : 0.5);
        assert.ok(
          Math.abs(exported.volume - expected) < 0.08,
          `${id} ${kind}: exactly one requested edge removes the analytical cut volume`,
        );
        assert.ok(
          Math.abs(local.volume - exported.volume) < 0.15,
          `${id}: preview and exported STEP use the same selected edge`,
        );
        assert.equal(exported.solids, 1);
        const vertices = imported.meshes.flatMap((mesh: Mesh) => {
          const values = mesh.attributes.position.array;
          return Array.from({ length: values.length / 3 }, (_, i) => ({
            x: values[i * 3],
            y: values[i * 3 + 1],
            z: values[i * 3 + 2],
          }));
        });
        for (const x of [-10, 10])
          for (const y of [-8, 8])
            for (const z of [-4, 4]) {
              const selectedCorner =
                id === 'side:0'
                  ? x === -10 && y === -8
                  : id === 'side:2'
                    ? x === 10 && y === 8
                    : y === -8 && z === 4;
              const nearest = Math.min(
                ...vertices.map((point: ModelCadVector) =>
                  Math.hypot(point.x - x, point.y - y, point.z - z),
                ),
              );
              assert.ok(
                selectedCorner ? nearest > 0.1 : nearest < 1e-5,
                `${id}: ${x},${y},${z} ${selectedCorner ? 'is rounded/cut' : 'remains sharp'}`,
              );
            }
      }
      const drilled: ModelCadObject = {
        ...base,
        holes: [{ id: uid(), x: 0, y: 0, diameterMm: 4 }],
        edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: ['hole:top:0'] },
      };
      const preview = await service.preview(drilled);
      const bytes = await createEnclosureStep(
        withModelCad(project, { version: 1, objects: [drilled] }),
      );
      const imported = occt.ReadStepFile(bytes, {
        linearUnit: 'millimeter',
        linearDeflectionType: 'bounding_box_ratio',
        linearDeflection: 0.003,
        angularDeflection: 0.5,
      });
      assert.equal(imported.success, true);
      const local = measure(preview.meshes),
        exported = measure(imported.meshes);
      const precise = occt.ReadStepFile(bytes, {
        linearUnit: 'millimeter',
        linearDeflectionType: 'absolute_value',
        linearDeflection: 0.002,
        angularDeflection: 0.1,
      });
      assert.equal(precise.success, true);
      const preciseVolume = measure(precise.meshes).volume;
      assert.ok(preciseVolume > 0 && preciseVolume < 2560 - Math.PI * 4 * 8);
      assert.ok(
        Math.abs(local.volume - exported.volume) < 0.3,
        `Hole rim preview/export volumes agree (${local.volume}, ${exported.volume}).`,
      );
      assert.equal(
        (bytes.toString('ascii').match(/TOROIDAL_SURFACE\(/g) ?? []).length,
        1,
        'Only the selected top hole rim becomes toroidal.',
      );
    } finally {
      service.close();
    }
  },
);

test(
  'native OCC CAD preview and posed analytical STEP agree for sketches, rims and Booleans',
  {
    skip: process.env.OPENPE_TEST_MODEL_CAD !== '1',
    timeout: 360_000,
  },
  async () => {
    // Explicit CAD-only -0 verification; no mesh solver, Electron, providers or downloads.
    const fixture = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
    const pcb = JSON.stringify(fixture.pcb);
    const directory = `test-results/model-cad-kernel/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await mkdir(directory, { recursive: true });
    const objects: ModelCadObject[] = [];
    const rectangle = body('rectangle');
    const circle = {
      ...body('circle'),
      size: { x: 20, y: 20, z: 8 },
      profile: { kind: 'circle' } as const,
    };
    const polygon = {
      ...body('polygon'),
      profile: {
        kind: 'polygon' as const,
        points: [
          { x: -10, y: -8 },
          { x: 10, y: -8 },
          { x: 8, y: 8 },
          { x: -10, y: 8 },
        ],
      },
    };
    objects.push(rectangle, circle, polygon);
    for (const kind of ['chamfer', 'fillet'] as const) {
      for (const [name, edges] of [
        ['top', ['profile:top:0']],
        ['bottom', ['profile:bottom:0']],
        ['both', ['profile:top:0', 'profile:bottom:0']],
      ] as const)
        objects.push({
          ...body(`${kind}-${name}`),
          edgeTreatment: { kind, edges: [...edges], distanceMm: 0.5 },
        });
      for (const source of [circle, polygon])
        objects.push({
          ...source,
          id: uid(),
          name: `${source.name}-${kind}-both`,
          edgeTreatment: { kind, edges: ['profile:top:0', 'profile:bottom:0'], distanceMm: 0.5 },
        });
    }
    const target: ModelCadObject = {
      ...body('boolean-target'),
      kind: 'box',
      holes: [{ id: uid(), x: -6, y: 0, diameterMm: 2 }],
    };
    delete target.profile;
    const tool: ModelCadObject = {
      ...target,
      id: uid(),
      name: 'boolean-tool',
      size: { x: 8, y: 6, z: 12 },
      holes: [{ id: uid(), x: 0, y: 0, diameterMm: 1.5 }],
    };
    for (const operation of ['union', 'difference', 'intersection'] as const) {
      const combined: ModelCadObject = {
        ...body(`boolean-${operation}`),
        kind: 'boolean',
        size: { x: 30, y: 30, z: 30 },
        boolean: {
          operation,
          operands: [
            {
              shape: modelCadShape(target),
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
            {
              shape: modelCadShape(tool),
              position: { x: 1, y: 0, z: 0 },
              rotation: { x: 17, y: 31, z: 30 },
            },
          ],
        },
      };
      delete combined.profile;
      objects.push(combined);
    }
    const occt = await createRequire(import.meta.url)('occt-import-js')();
    const service = createModelCadPreviewService();
    const evidence: Record<
      string,
      ReturnType<typeof measure> & { bytes: number; sha256: string; breps: number }
    > = {};
    try {
      for (const [index, object] of objects.entries()) {
        const artifact = `${directory}/${index}-${object.name.replace(/[^a-z0-9-]/gi, '-')}`;
        const source = modelCadStepGeometry(object);
        await writeFile(`${artifact}.geo`, source);
        const preview = await service.preview(object);
        const local = measure(preview.meshes),
          posed = measure(preview.meshes, object);
        assert.ok(
          local.volume > 0 && local.triangles > 0,
          `${object.name} preview must contain positive solid volume`,
        );
        const project = withModelCad(fixture, { version: 1, objects: [object] });
        const bytes = await createEnclosureStep(project),
          text = bytes.toString('ascii');
        await writeFile(`${artifact}.step`, bytes);
        const imported = occt.ReadStepFile(bytes, {
          linearUnit: 'millimeter',
          linearDeflectionType: 'bounding_box_ratio',
          linearDeflection: 0.003,
          angularDeflection: 0.5,
        });
        assert.equal(imported.success, true, `${object.name} exported STEP must reimport`);
        const exported = measure(imported.meshes);
        assert.equal(
          exported.solids,
          local.solids,
          `${object.name} preview/export solid counts agree`,
        );
        for (const edge of ['min', 'max'] as const)
          for (const axis of ['x', 'y', 'z'] as const)
            assert.ok(
              Math.abs(exported[edge][axis] - posed[edge][axis]) < 0.12,
              `${object.name} ${edge}.${axis} preview/export bounds agree`,
            );
        assert.ok(
          Math.abs(exported.volume - local.volume) < Math.max(0.2, local.volume * 0.02),
          `${object.name} preview/export volumes agree`,
        );
        const breps = (text.match(/MANIFOLD_SOLID_BREP\(/g) || []).length;
        assert.equal(breps, local.solids, `${object.name} keeps real manifold STEP solids`);
        evidence[object.name] = {
          ...local,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          breps,
        };
        console.log(
          `CAD native ${object.name}: ${breps} solid(s), ${local.triangles} triangles, ${local.volume.toFixed(3)} mm3`,
        );
      }
      for (const [name, wanted] of [
        ['rectangle', 20 * 16 * 8],
        ['circle', Math.PI * 10 ** 2 * 8],
        ['polygon', 304 * 8],
      ] as const)
        assert.ok(
          Math.abs(evidence[name].volume - wanted) < wanted * 0.015,
          `${name} agrees with independent profile-area × depth`,
        );
      for (const kind of ['chamfer', 'fillet'] as const) {
        const base = evidence.rectangle.volume,
          top = evidence[`${kind}-top`].volume,
          bottom = evidence[`${kind}-bottom`].volume,
          both = evidence[`${kind}-both`].volume;
        assert.ok(
          top < base && bottom < base && both < top && both < bottom,
          `${kind} removes only the requested rims`,
        );
        assert.ok(Math.abs(top - bottom) < 0.2, `${kind} opposite rims are symmetric`);
      }
      const a = 20 * 16 * 8 - Math.PI * 1 ** 2 * 8;
      const b = 8 * 6 * 12 - Math.PI * 0.75 ** 2 * 12;
      const union = evidence['boolean-union'].volume,
        difference = evidence['boolean-difference'].volume,
        intersection = evidence['boolean-intersection'].volume;
      assert.ok(
        Math.abs(union + intersection - a - b) < 5,
        'Rotated/holed Boolean union/intersection conserve operand volume',
      );
      assert.ok(
        Math.abs(difference + intersection - a) < 5,
        'Rotated/holed Boolean difference/intersection partition the target',
      );
      const emptyOperand = () => ({
        shape: modelCadShape(rectangle),
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      });
      const empty: ModelCadObject = {
        ...body('empty-difference'),
        kind: 'boolean',
        boolean: {
          operation: 'difference',
          operands: [emptyOperand(), emptyOperand()],
        },
      };
      delete empty.profile;
      await assert.rejects(
        service.preview(empty),
        /produced no solid|produced an empty solid/,
        'An empty native Boolean must reject before Core can commit',
      );
      assert.equal(JSON.stringify(fixture.pcb), pcb, 'Native kernel operations retain PCB bytes');
      await writeFile(
        `${directory}/summary.json`,
        JSON.stringify(
          {
            engine:
              'Verified bundled Gmsh 4.15.2 OpenCASCADE -0; independent occt-import-js reimport; no simulation',
            cases: evidence,
          },
          null,
          2,
        ) + '\n',
      );
      console.log(`CAD native evidence: ${directory}/summary.json`);
    } finally {
      service.close();
    }
  },
);
