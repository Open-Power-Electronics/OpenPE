import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uid } from '../lib/circuit';
import { withModelCad, type ModelCadObject } from '../lib/model-cad';
import { parseProject } from '../lib/project';
import { extrudeModelCadSketch } from '../lib/model-cad-sketch';
import { enclosureStepGeometry } from '../server/enclosure-step.mjs';

const fixture = () =>
  withModelCad(parseProject(readFileSync('lib/emc-flyback-example.json', 'utf8')), null);
const body = (kind: ModelCadObject['kind'] = 'box'): ModelCadObject => ({
  id: uid(),
  name: 'Body',
  kind,
  position: { x: 100, y: 88, z: 20 },
  rotation: { x: 17, y: 31, z: 43 },
  size: { x: 20, y: 20, z: 10 },
  material: 'aluminium',
  opacity: 1,
});

test('STEP supports CAD bodies without an enclosure, with local cuts before XYZ pose', () => {
  const seed = body();
  const cutBody = extrudeModelCadSketch({
    id: seed.id,
    name: seed.name,
    plane: 'XY',
    origin: seed.position,
    distance: 10,
    direction: 'symmetric',
    material: seed.material,
    opacity: seed.opacity,
    contours: [
      {
        operation: 'union',
        profile: { kind: 'rectangle' },
        size: { x: 20, y: 20 },
        position: { x: 0, y: 0 },
      },
      {
        operation: 'difference',
        profile: { kind: 'circle' },
        size: { x: 3, y: 3 },
        position: { x: 2, y: 1 },
      },
    ],
  });
  const project = withModelCad(fixture(), {
    version: 1,
    objects: [{ ...cutBody, rotation: seed.rotation }],
  });
  const pcb = JSON.stringify(project.pcb);
  const geometry = enclosureStepGeometry(project);
  assert.match(geometry, /Rectangle\([^)]*\) = \{-10,-10,-5,20,20\};/);
  assert.match(geometry, /Disk\([^)]*\) = \{0,0,-5,1\.5,1\.5\};/);
  const cut = geometry.indexOf('BooleanDifference'),
    z = geometry.indexOf('Rotate {{0,0,1}, {0,0,0}, 43*Pi/180}'),
    y = geometry.indexOf('Rotate {{0,1,0}, {0,0,0}, 31*Pi/180}'),
    x = geometry.indexOf('Rotate {{1,0,0}, {0,0,0}, 17*Pi/180}'),
    translate = geometry.indexOf('Translate {100,88,20}');
  assert.ok(cut > 0 && cut < z && z < y && y < x && x < translate);
  assert.equal(
    JSON.stringify(project.pcb),
    pcb,
    'STEP construction never edits native PCB geometry',
  );
});

test('STEP keeps independently editable overlapping boxes and cylinders as separate solids', () => {
  const project = withModelCad(fixture(), { version: 1, objects: [body(), body('cylinder')] });
  const geometry = enclosureStepGeometry(project);
  assert.equal(
    (geometry.match(/BooleanUnion/g) || []).length,
    0,
    'Independent CAD bodies remain separate',
  );
  assert.doesNotMatch(geometry, /Coherence/);
  assert.match(geometry, /Cylinder\([^)]*\) = \{0,0,-5,0,0,10,10,2\*Pi\};/);
  assert.match(
    geometry,
    /\w+_volume\d+ = newv;/,
    'Primitive tags must follow OCC-generated Boolean tags',
  );
});

test('STEP input remains bounded domain geometry and never interpolates object names as code', () => {
  const project = fixture();
  assert.throws(() => enclosureStepGeometry(project), /Create a CAD object/);
  const model = body();
  model.name = 'Box"; SystemCall("command"); //';
  const target = withModelCad(project, { version: 1, objects: [model] });
  assert.doesNotMatch(enclosureStepGeometry(target), /SystemCall|command|Box"/);
  const invalid = structuredClone(target);
  (invalid.extensions['org.openpe.model-cad'] as { objects: ModelCadObject[] }).objects[0].size.x =
    Infinity;
  assert.throws(() => enclosureStepGeometry(invalid), /Invalid object|Invalid model/);
});
