import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { MeshData } from '../lib/model-mesh';
import { createStepParserPool } from '../server/libraries.mjs';

test('Würth STEP assembly previews recover source colours without changing posed geometry', async () => {
  const parser = await createRequire(import.meta.url)('occt-import-js')();
  // Exercise geometry and colour on emulated build hosts as well. The parser
  // pool's timeout and worker retirement are covered in step-parser-pool.test.ts.
  const pool = createStepParserPool({ timeoutMs: 180_000 });
  const library = '../resources/example-catalog/footprints/';
  const models = [
    'models/Inductor_SMD_Wurth.3dshapes/L_Wurth_WE-DD-7345straight.step',
    'models/Inductor_SMD_Wurth.3dshapes/L_Wurth_WE-LQSH-2010.step',
    'models/Inductor_SMD_Wurth.3dshapes/L_Wurth_WE-LQSH-2512.step',
    'emc-flyback/models/WE-CMB_744822222.step',
  ];
  const geometry = (meshes: MeshData[]) =>
    meshes.map(({ attributes, index, brep_faces }) => ({
      attributes,
      index,
      faces: brep_faces?.map(({ first, last }) => [first, last]),
    }));
  try {
    for (const file of models) {
      const source = await readFile(new URL(library + file, import.meta.url));
      const reference = parser.ReadStepFile(source, {
        linearUnit: 'millimeter',
        linearDeflectionType: 'bounding_box_ratio',
        linearDeflection: 0.003,
        angularDeflection: 0.5,
      });
      assert.ok(reference.success);
      const { meshes }: { meshes: MeshData[] } = await pool.run(source);
      assert.deepEqual(geometry(meshes), geometry(reference.meshes), file);
      assert.ok(
        meshes.every((mesh) => mesh.color || mesh.brep_faces?.some((face) => face.color)),
        file,
      );
      assert.ok(
        meshes.some((mesh) => mesh.brep_faces?.some((face) => face.color)),
        file,
      );
      const colors = meshes.flatMap((mesh) => [
        mesh.color,
        ...(mesh.brep_faces ?? []).map((face) => face.color),
      ]);
      assert.ok(new Set(colors.filter(Boolean).map((rgb) => JSON.stringify(rgb))).size >= 4, file);
    }
  } finally {
    pool.close();
  }
});
