import { exampleModelPath } from '../lib/example-model-paths';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHomeExample } from '../lib/create-home-example';
import { homeExampleCatalog, homeExamples, homeRecent } from '../lib/home-examples';
import { validExampleKey } from '../lib/workspace-example';
import {
  parseProject,
  projectNativeFiles,
  projectFromNativeFiles,
  serializeProject,
} from '../lib/project';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import { schematicPolylines, schematicTexts } from '../lib/schematic-text';
import { defaultTransient, simulationSupportError } from '../lib/spice';
import { modelCadFromProject, MODEL_CAD_NATIVE_VARIABLE } from '../lib/model-cad';
import { arrangeExampleText } from '../lib/example-layout';
import { parseCircuit } from '../lib/circuit';
import { buildSpiceDeck } from '../lib/spice';
import { prepareEmcFlybackValues } from '../scripts/emc-flyback-values';
import { partFields } from '../lib/library';

test('EMC native passive values separate specifications and retain them through native round trips', () => {
  const project = createHomeExample('emc-flyback-demo');
  const original = parseCircuit(
    readFileSync(
      'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_sch',
      'utf8',
    ),
  );
  const native = projectNativeFiles(project, 'emc-flyback.kicad_pro');
  const reopened = projectFromNativeFiles(native);
  const board = parseSExpr(native.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source);
  for (const before of original.parts.filter((part) => /^[RCL]\d+$/.test(part.ref))) {
    const [nominal, ...details] = before.value.split(/\s+/);
    const after = reopened.schematic.parts.find((part) => part.ref === before.ref)!;
    assert.equal(after.value, nominal, before.ref);
    if (details.length)
      assert.equal(partFields(after).Specifications, details.join(' '), before.ref);
    const footprint = children(board, 'footprint').find((fp) =>
      children(fp, 'property').some(
        (field) => val(field) === 'Reference' && val(field, 2) === before.ref,
      ),
    )!;
    const field = (name: string) =>
      children(footprint, 'property').find((node) => val(node) === name);
    assert.equal(val(field('Value'), 2), nominal, before.ref);
    if (details.length)
      assert.equal(val(field('Specifications'), 2), details.join(' '), before.ref);
  }
  assert.equal(reopened.schematic.parts.find((part) => part.ref === 'L2')!.value, '10uH');
  assert.equal(simulationSupportError(reopened.schematic), '');
});

test('EMC annotation layout changes only instance field placement and preserves the full SPICE deck', () => {
  const circuit = parseCircuit(
    readFileSync(
      'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_sch',
      'utf8',
    ),
  );
  prepareEmcFlybackValues(circuit);
  const before = structuredClone(circuit);
  const deck = buildSpiceDeck(circuit, defaultTransient(circuit));
  arrangeExampleText(circuit, 'emc-flyback-demo');
  const withoutPlacement = (value: unknown): unknown => {
    if (!Array.isArray(value)) {
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, withoutPlacement(item)]),
        );
      return value;
    }
    if (value[0] === 'property' && ['Reference', 'Value'].includes(val(value))) {
      return value
        .filter((item) => !Array.isArray(item) || item[0] !== 'at')
        .map((item) =>
          Array.isArray(item) && item[0] === 'effects'
            ? item.filter((effect) => !Array.isArray(effect) || effect[0] !== 'justify')
            : item,
        );
    }
    return value.map(withoutPlacement);
  };
  assert.deepEqual(circuit.libraries, before.libraries);
  assert.deepEqual(withoutPlacement(circuit), withoutPlacement(before));
  assert.deepEqual(buildSpiceDeck(circuit, defaultTransient(circuit)), deck);
});

test('Home keeps EMC Flyback in Recent and restores the charge pump in Examples', () => {
  assert.equal(homeExamples.length, 9);
  assert.deepEqual(
    homeRecent.map((entry) => entry.id),
    ['emc-flyback-demo'],
  );
  assert.equal(homeExampleCatalog.length, 10);
  assert.ok(!homeExamples.some((entry) => entry.id === 'emc-flyback-demo'));
  assert.ok(homeExamples.some((entry) => entry.id === 'reference-lm27761-wson8-pump'));
  assert.ok(validExampleKey('example:reference-lm27761-wson8-pump'));
  assert.ok(validExampleKey('example:emc-flyback-demo'));
});

test('EMC editable copies retain native KiCad 10 geometry, independent IDs, notes and device links', () => {
  const a = createHomeExample('emc-flyback-demo'),
    b = createHomeExample('emc-flyback-demo');
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.schematic.id, b.schematic.id);
  const cadA = modelCadFromProject(a)!,
    cadB = modelCadFromProject(b)!;
  assert.equal(Object.hasOwn(a.extensions, 'org.openpe.enclosure'), false);
  assert.equal(cadA.objects.length, 4);
  assert.notEqual(cadA.objects[0].id, cadB.objects[0].id);
  assert.notEqual(cadA.objects[0].holes[0].id, cadB.objects[0].holes[0].id);
  assert.equal(cadA.objects.flatMap((body) => body.holes).length, 8);
  assert.equal(a.schematic.parts.length, 140);
  assert.equal(a.pcb!.footprints.length, 90);
  assert.equal(a.pcb!.tracks.length, 359);
  assert.equal(a.pcb!.vias.length, 155);
  const q = a.schematic.parts.find((p) => p.ref === 'Q1')!;
  assert.ok(a.pcb!.footprints.some((fp) => fp.symbolId === q.id));
  assert.ok(schematicPolylines(a.schematic.original).length > 0);
  assert.ok(schematicTexts(a.schematic.original).some((t) => t.bold));
  assert.ok(schematicTexts(a.schematic.original).some((t) => t.href?.startsWith('https://')));
  assert.equal(simulationSupportError(a.schematic), '');
  assert.equal(defaultTransient(a.schematic).stop, 0.01);
  const parsed = parseProject(serializeProject(a));
  assert.deepEqual(schematicTexts(parsed.schematic.original), schematicTexts(a.schematic.original));
  const bundle = projectNativeFiles(parsed, 'flyback.kicad_pro');
  assert.equal(
    val(
      child(parseSExpr(bundle.files.find((f) => f.name.endsWith('.kicad_sch'))!.source), 'version'),
    ),
    '20260306',
  );
  const board = parseSExpr(bundle.files.find((f) => f.name.endsWith('.kicad_pcb'))!.source);
  assert.equal(val(child(board, 'version')), '20260206');
  assert.equal(
    children(board, 'segment').filter((n) => val(child(n, 'locked')) === 'yes').length,
    124,
  );
  const nativeCopy = projectFromNativeFiles(bundle);
  assert.equal(nativeCopy.pcb!.footprints.length, 90);
  assert.equal(Object.hasOwn(nativeCopy.extensions, 'org.openpe.enclosure'), false);
  assert.deepEqual(modelCadFromProject(nativeCopy), cadA);
  const settings = JSON.parse(
    bundle.files.find((file) => file.name.endsWith('.kicad_pro'))!.source,
  );
  assert.ok(!('OPENPE_ENCLOSURE' in settings.text_variables));
  assert.deepEqual(JSON.parse(settings.text_variables[MODEL_CAD_NATIVE_VARIABLE]), cadA);
});

test('EMC enclosure uses editable Model boxes with exact panel bounds, materials and through holes', () => {
  const project = createHomeExample('emc-flyback-demo'),
    bodies = modelCadFromProject(project)!.objects;
  assert.deepEqual(
    bodies.map((body) => ({
      kind: body.kind,
      size: body.size,
      position: body.position,
      rotation: body.rotation,
      material: body.material,
      opacity: body.opacity,
      holes: body.holes.map(({ x, y, diameterMm }) => ({ x, y, diameterMm })),
    })),
    [
      {
        kind: 'box',
        size: { x: 112, y: 94, z: 3 },
        position: { x: 100, y: 88, z: -10.3 },
        rotation: { x: 0, y: 0, z: 0 },
        material: 'aluminium',
        opacity: 1,
        holes: [
          [-46.2, -34.2],
          [46.2, 34.2],
          [46.2, -34.2],
          [-46.2, 34.2],
        ].map(([x, y]) => ({ x, y, diameterMm: 3.2 })),
      },
      ...[42.5, 133.5].map((y) => ({
        kind: 'box',
        size: { x: 112, y: 3, z: 30 },
        position: { x: 100, y, z: 6.2 },
        rotation: { x: 0, y: 0, z: 0 },
        material: 'aluminium',
        opacity: 1,
        holes: [],
      })),
      {
        kind: 'box',
        size: { x: 112, y: 94, z: 3 },
        position: { x: 100, y: 88, z: 22.7 },
        rotation: { x: 0, y: 0, z: 0 },
        material: 'pmma',
        opacity: 0.3,
        holes: [
          [-48, -41],
          [-48, 41],
          [48, -41],
          [48, 41],
        ].map(([x, y]) => ({ x, y, diameterMm: 3.2 })),
      },
    ],
  );
  assert.deepEqual(bodies[0].size, { x: 112, y: 94, z: 3 });
  assert.deepEqual(bodies[0].position, { x: 100, y: 88, z: -10.3 });
  assert.deepEqual(bodies[3].position, { x: 100, y: 88, z: 22.7 });
});

test('EMC replacement hides only the two original case instances and retains their model transforms', () => {
  const project = createHomeExample('emc-flyback-demo');
  const original = parseSExpr(
    readFileSync(
      'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_pcb',
      'utf8',
    ),
  );
  const generated = parseSExpr(
    projectNativeFiles(project).files.find((file) => file.name.endsWith('.kicad_pcb'))!.source,
  );
  const reference = (footprint: ReturnType<typeof parseSExpr>) => {
    const property = children(footprint, 'property').find((node) => val(node) === 'Reference');
    return property
      ? val(property, 2)
      : val(
          children(footprint, 'fp_text').find((node) => val(node) === 'reference'),
          2,
        );
  };
  const hidden = project.pcb!.footprints.flatMap((footprint) =>
    (footprint.models ?? []).filter((model) => model.hidden).map(() => footprint.reference),
  );
  assert.deepEqual(hidden.sort(), ['MECH1', 'MECH2']);
  for (const ref of ['MECH1', 'MECH2']) {
    const before = children(original, 'footprint').find((fp) => reference(fp) === ref)!,
      after = children(generated, 'footprint').find((fp) => reference(fp) === ref)!,
      beforeModel = child(before, 'model')!,
      afterModel = child(after, 'model')!;
    assert.equal(
      val(afterModel),
      '${KIPRJMOD}/' + exampleModelPath('emc-flyback-demo/' + val(beforeModel).split('/').at(-1)!),
    );
    for (const key of ['offset', 'scale', 'rotate', 'opacity'])
      assert.deepEqual(child(afterModel, key), child(beforeModel, key));
    assert.equal(val(child(afterModel, 'hide')), 'yes');
  }
});

test('native schematic note outlines reject unsupported or malformed geometry', () => {
  const source = parseSExpr(readFileSync('examples/emc-flyback/emc-flyback.kicad_sch', 'utf8'));
  const line = children(source, 'polyline')[0];
  child(child(line, 'pts')!, 'xy')![1] = 'NaN';
  assert.throws(() => schematicPolylines(source), /Unsupported schematic polyline/);
});
