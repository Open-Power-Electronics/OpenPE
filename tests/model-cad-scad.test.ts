import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { ModelCAD, ModelCadObject } from '../lib/model-cad';
import { exportModelCadScad } from '../lib/model-cad-scad';

const header = [
  '// OpenPE Model CAD exported for OpenSCAD.',
  '// OpenPE does not read this file; edit the model in OpenPE and export again.',
  '// Units: millimetres. Native PCB X/Y axes; Z = 0 is the PCB mid-plane.',
  '// OpenSCAD facets circular geometry with $fn.',
  '',
  '$fn = 96;',
  '',
];
const zero = { x: 0, y: 0, z: 0 };
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const body = (
  properties: Pick<ModelCadObject, 'id' | 'name' | 'kind' | 'size'> & Partial<ModelCadObject>,
): ModelCadObject => ({
  position: zero,
  rotation: zero,
  material: 'aluminium',
  opacity: 1,
  ...properties,
});

const fixture = (): ModelCAD => ({
  version: 1,
  objects: [
    body({
      id: uuid(1),
      name: 'Post',
      kind: 'cylinder',
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 10, y: 20, z: 30 },
      size: { x: 6, y: 6, z: 4 },
      material: 'plastic',
    }),
    body({
      id: uuid(2),
      name: 'Plate',
      kind: 'extrusion',
      size: { x: 20, y: 10, z: 2 },
      profile: { kind: 'rectangle' },
      material: 'pmma',
      opacity: 0.5,
    }),
    body({
      id: uuid(4),
      name: 'Disc',
      kind: 'extrusion',
      position: { x: 0, y: 0, z: -2 },
      rotation: { x: 0, y: 90, z: 0 },
      size: { x: 8, y: 8, z: 1 },
      profile: { kind: 'circle' },
    }),
    body({
      id: uuid(5),
      name: 'Wedge',
      kind: 'extrusion',
      position: { x: -3.5, y: 0.25, z: 0 },
      size: { x: 4, y: 2, z: 1 },
      profile: {
        kind: 'polygon',
        points: [
          { x: -2, y: -1 },
          { x: 2, y: -1 },
          { x: -2, y: 1 },
        ],
      },
      material: 'plastic',
      opacity: 0.8,
    }),
    body({
      id: uuid(6),
      name: 'Bored block',
      kind: 'boolean',
      position: { x: 50, y: 60, z: 5 },
      rotation: { x: 0, y: 0, z: 45 },
      size: { x: 10, y: 10, z: 10 },
      boolean: {
        operation: 'difference',
        operands: [
          {
            shape: {
              kind: 'box',
              size: { x: 10, y: 10, z: 10 },
            },
            position: zero,
            rotation: zero,
          },
          {
            shape: {
              kind: 'boolean',
              size: { x: 4, y: 4, z: 12 },
              boolean: {
                operation: 'intersection',
                operands: [
                  {
                    shape: { kind: 'cylinder', size: { x: 4, y: 4, z: 12 } },
                    position: zero,
                    rotation: zero,
                  },
                  {
                    shape: { kind: 'box', size: { x: 4, y: 4, z: 12 } },
                    position: zero,
                    rotation: zero,
                  },
                ],
              },
            },
            position: { x: -1, y: 0, z: 0 },
            rotation: { x: 90, y: 0, z: 0 },
          },
        ],
      },
    }),
  ],
});

test('OpenSCAD uses per-body RGB overrides while retaining geometry and opacity', () => {
  const input = fixture();
  const original = exportModelCadScad(input);
  input.objects[0].color = '#3366cc';
  const colored = exportModelCadScad(input);
  assert.ok(colored.includes(`color([0.2, 0.4, 0.8, ${input.objects[0].opacity}])`));
  assert.equal(
    colored.replace(/color\(\[[^\]]+\]\)/g, 'color()'),
    original.replace(/color\(\[[^\]]+\]\)/g, 'color()'),
  );
  delete input.objects[0].color;
  assert.equal(exportModelCadScad(input), original);
});

test('OpenSCAD export writes every solid kind with intrinsic XYZ poses and nested Booleans', () => {
  const model = fixture();
  const original = structuredClone(model);
  assert.equal(
    exportModelCadScad(model),
    [
      ...header,
      '// Post',
      'color([0.467, 0.486, 0.51, 1])',
      '  translate([1, 2, 3])',
      '    rotate([10, 0, 0])',
      '      rotate([0, 20, 0])',
      '        rotate([0, 0, 30])',
      '          cylinder(h = 4, d = 6, center = true);',
      '',
      '// Plate',
      'color([0.863, 0.925, 0.937, 0.5])',
      '  linear_extrude(height = 2, center = true)',
      '    square([20, 10], center = true);',
      '',
      '// Disc',
      'color([0.749, 0.765, 0.776, 1])',
      '  translate([0, 0, -2])',
      '    rotate([0, 90, 0])',
      '      linear_extrude(height = 1, center = true)',
      '        circle(d = 8);',
      '',
      '// Wedge',
      'color([0.467, 0.486, 0.51, 0.8])',
      '  translate([-3.5, 0.25, 0])',
      '    linear_extrude(height = 1, center = true)',
      '      polygon([[-2, -1], [2, -1], [-2, 1]]);',
      '',
      '// Bored block',
      'color([0.749, 0.765, 0.776, 1])',
      '  translate([50, 60, 5])',
      '    rotate([0, 0, 45])',
      '      difference() {',
      '        cube([10, 10, 10], center = true);',
      '        translate([-1, 0, 0])',
      '          rotate([90, 0, 0])',
      '            intersection() {',
      '              cylinder(h = 12, d = 4, center = true);',
      '              cube([4, 4, 12], center = true);',
      '            }',
      '      }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(model, original);
});

test('OpenSCAD export reproduces the EMC Flyback enclosure from its native Model CAD', async () => {
  const native = JSON.parse(
    await readFile('examples/project/emc-flyback/emc-flyback.kicad_pro', 'utf8'),
  ) as {
    text_variables: Record<string, string>;
  };
  const model = JSON.parse(native.text_variables.OPENPE_MODEL_CAD) as ModelCAD;
  const original = structuredClone(model);
  const scad = exportModelCadScad(model);
  assert.ok(scad.startsWith(header.join('\n')));
  assert.doesNotMatch(scad, /through_holes/);
  assert.deepEqual(
    scad.match(/^\/\/ (?!OpenPE|Units|OpenSCAD|Cuts).+$/gm),
    model.objects.map((object) => `// ${object.name}`),
  );
  for (const object of model.objects) {
    assert.ok(
      scad.includes(
        `  translate([${object.position.x}, ${object.position.y}, ${object.position.z}])\n`,
      ),
    );
    assert.ok(
      scad.includes(
        object.kind === 'box'
          ? `cube([${object.size.x}, ${object.size.y}, ${object.size.z}], center = true);`
          : `square([${object.size.x}, ${object.size.y}], center = true);`,
      ),
    );
  }
  assert.equal(scad.match(/^color\(\[0\.749, 0\.765, 0\.776, 1\]\)$/gm)?.length, 3);
  assert.equal(scad.match(/^color\(\[0\.863, 0\.925, 0\.937, 0\.3\]\)$/gm)?.length, 1);
  assert.equal(scad.match(/difference\(\)/g)?.length, 8);
  assert.equal(scad.match(/circle\(d = 3\.2\)/g)?.length, 8);
  assert.ok(!scad.includes('rotate('));
  assert.deepEqual(model, original);
});

test('OpenSCAD export omits the hole module for undrilled solids', () => {
  const model: ModelCAD = {
    version: 1,
    objects: [body({ id: uuid(7), name: 'Box', kind: 'box', size: { x: 1, y: 2, z: 3 } })],
  };
  assert.equal(
    exportModelCadScad(model),
    [
      ...header,
      '// Box',
      'color([0.749, 0.765, 0.776, 1])',
      '  cube([1, 2, 3], center = true);',
      '',
    ].join('\n'),
  );
});

test('OpenSCAD export rejects edge treatments, empty models and invalid Model CAD', () => {
  const chamfered: ModelCAD = {
    version: 1,
    objects: [
      body({
        id: uuid(7),
        name: 'Chamfered box',
        kind: 'box',
        size: { x: 10, y: 10, z: 10 },
        edgeTreatment: { kind: 'chamfer', distanceMm: 0.5, edges: ['profile:top:0'] },
      }),
    ],
  };
  assert.throws(
    () => exportModelCadScad(chamfered),
    /^Error: OpenSCAD export: Chamfered box has chamfered or filleted edges, which OpenSCAD cannot represent\.$/,
  );
  const nested = fixture();
  const operand = nested.objects[4].boolean!.operands[0].shape;
  operand.edgeTreatment = { kind: 'fillet', distanceMm: 0.5, edges: ['side:0'] };
  assert.throws(
    () => exportModelCadScad(nested),
    /OpenSCAD export: Bored block has chamfered or filleted edges/,
  );
  assert.throws(
    () => exportModelCadScad({ version: 1, objects: [] }),
    /^Error: OpenSCAD export: Create a CAD solid before exporting OpenSCAD\.$/,
  );
  for (const invalid of [null, { version: 2, objects: [] }, { version: 1 }])
    assert.throws(() => exportModelCadScad(invalid), /Invalid model/);
  const unsupported = fixture();
  unsupported.objects[0].size.y = 5;
  assert.throws(() => exportModelCadScad(unsupported), /equal X and Y diameters/);
});
