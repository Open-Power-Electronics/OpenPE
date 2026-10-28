import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODEL_CAD_NATIVE_VARIABLE, type ModelCAD } from '../lib/model-cad';
import { serializeEmcFlybackScad } from '../scripts/emc-flyback-scad';

function nativeModel(): ModelCAD {
  const settings = JSON.parse(readFileSync('examples/emc-flyback/emc-flyback.kicad_pro', 'utf8'));
  return JSON.parse(settings.text_variables[MODEL_CAD_NATIVE_VARIABLE]);
}

function parameter(source: string, name: string): unknown {
  const match = source.match(new RegExp(`^${name} = (.+);$`, 'm'));
  assert.ok(match, `Editable SCAD parameter ${name} is present.`);
  return JSON.parse(match[1]);
}

test('EMC SCAD parameters retain the actual native panels, mounting holes and transparent cover', () => {
  const model = nativeModel();
  const before = JSON.stringify(model);
  const source = readFileSync('examples/emc-flyback/emc-flyback.scad', 'utf8');
  assert.equal(source, serializeEmcFlybackScad(model));
  const panelNames = [
    ['base', 'Aluminium base'],
    ['front_wall', 'Aluminium front wall'],
    ['back_wall', 'Aluminium back wall'],
    ['cover', 'Transparent cover'],
  ];
  let holes = 0;
  for (const [key, name] of panelNames) {
    const body = model.objects.find((candidate) => candidate.name === name)!;
    assert.ok(body, `Actual native panel ${name} exists.`);
    assert.deepEqual(parameter(source, `${key}_size`), [body.size.x, body.size.y, body.size.z]);
    assert.deepEqual(parameter(source, `${key}_position`), [
      body.position.x,
      body.position.y,
      body.position.z,
    ]);
    assert.deepEqual(
      parameter(source, `${key}_holes`),
      body.holes.map((hole) => [hole.x, hole.y, hole.diameterMm]),
    );
    assert.equal(parameter(source, `${key}_opacity`), body.opacity);
    assert.ok(source.includes(`module ${key}_panel()`));
    assert.ok(source.includes(`translate(${key}_position)`));
    holes += body.holes.length;
  }
  assert.equal(holes, 8);
  assert.equal((parameter(source, 'base_holes') as unknown[]).length, 4);
  assert.equal((parameter(source, 'cover_holes') as unknown[]).length, 4);
  assert.equal(parameter(source, 'cover_opacity'), 0.3);
  assert.match(source, /Native PCB X\/Y axes; Z = 0 is the PCB mid-plane/);
  assert.match(source, /cube\(dimensions, center = true\)/);
  assert.match(
    source,
    /cylinder\(h = dimensions\[2\] \+ 2 \* cut_margin_mm, d = hole\[2\], center = true\)/,
  );
  assert.doesNotMatch(source, /\b(?:import|include|use)\s*[<(]/);
  assert.equal(JSON.stringify(model), before, 'Source generation leaves the native model intact.');
});

test('EMC SCAD rejects unsupported construction and malformed native data without emitting approximations', () => {
  const cases: [string, (model: ModelCAD) => void][] = [
    [
      'unrotated',
      (model) => {
        model.objects[1].rotation.z = 90;
      },
    ],
    [
      'axis-aligned box',
      (model) => {
        model.objects[1].kind = 'cylinder';
        model.objects[1].size.y = model.objects[1].size.x;
      },
    ],
    [
      'Edge treatments',
      (model) => {
        model.objects[1].edgeTreatment = {
          kind: 'chamfer',
          distanceMm: 0.2,
          edges: ['profile:top:0'],
        };
      },
    ],
    [
      'through-hole pattern',
      (model) => {
        model.objects[0].holes.pop();
      },
    ],
    [
      'four named',
      (model) => {
        model.objects.pop();
      },
    ],
    [
      'exactly one',
      (model) => {
        model.objects[0].name = 'different panel';
      },
    ],
  ];
  for (const [message, mutate] of cases) {
    const model = nativeModel();
    mutate(model);
    assert.throws(() => serializeEmcFlybackScad(model), new RegExp(message));
  }
  const malformed = nativeModel();
  malformed.objects[0].size.x = Number.NaN;
  assert.throws(() => serializeEmcFlybackScad(malformed), /Model CAD/);
});
