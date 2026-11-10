import test from 'node:test';
import type { ModelCadObject, ModelCadShape } from '../lib/model-cad';
const panelCuts = (body: ModelCadObject) => {
  const collect = (shape: ModelCadShape): { x: number; y: number; diameterMm: number }[] => {
    if (shape.kind !== 'boolean') return [];
    assert.equal(shape.boolean!.operation, 'difference');
    const [target, tool] = shape.boolean!.operands;
    assert.equal(tool.shape.profile?.kind, 'circle');
    return [
      ...collect(target.shape),
      { x: tool.position.x, y: tool.position.y, diameterMm: tool.shape.size.x },
    ];
  };
  return collect(body);
};
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHomeExample } from '../lib/create-home-example';
import { homeExampleCatalog, homeExamples, homeRecent } from '../lib/home-examples';
import { validExampleKey } from '../lib/workspace-example';
import {
  parseProject,
  projectNativeFiles,
  projectFromNativeFiles,
  serializeProject,
} from '../lib/project';
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';
import { schematicPolylines, schematicTexts } from '../lib/schematic-text';
import { defaultTransient, simulationSupportError } from '../lib/spice';
import { modelCadFromProject, MODEL_CAD_NATIVE_VARIABLE } from '../lib/model-cad';
import { arrangeExampleText } from '../lib/example-layout';
import { parseCircuit, serializeCircuit } from '../lib/circuit';
import { buildSpiceDeck } from '../lib/spice';
import { prepareEmcFlybackValues } from '../scripts/emc-flyback-values';
import { prepareEmcFlybackModelBindings } from '../scripts/emc-flyback-model-bindings';
import { prepareEmcFlybackTestbench } from '../scripts/emc-flyback-testbench';
import layout from '../scripts/emc-flyback-layout.json';
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
  prepareEmcFlybackModelBindings(circuit);
  prepareEmcFlybackTestbench(circuit);
  const before = structuredClone(circuit);
  const deck = buildSpiceDeck(circuit, defaultTransient(circuit));
  arrangeExampleText(circuit, 'emc-flyback-demo');
  const withoutPlacement = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
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
  assert.deepEqual(
    withoutPlacement(parseSExpr(serializeCircuit(circuit))),
    withoutPlacement(parseSExpr(serializeCircuit(before))),
  );
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
  assert.equal(cadA.objects.flatMap(panelCuts).length, 8);
  assert.equal(a.schematic.parts.length, 150);
  assert.equal(a.pcb!.footprints.length, 88);
  assert.equal(a.pcb!.tracks.length, 336);
  assert.equal(a.pcb!.vias.length, 155);
  const q = a.schematic.parts.find((p) => p.ref === 'Q1')!;
  assert.ok(a.pcb!.footprints.some((fp) => fp.symbolId === q.id));
  assert.ok(schematicPolylines(a.schematic.original).length > 0);
  assert.ok(schematicTexts(a.schematic.original).some((t) => t.bold));
  assert.ok(a.schematic.parts.some((part) => partFields(part).Datasheet?.startsWith('https://')));
  assert.ok(!schematicTexts(a.schematic.original).some((t) => /^7\./.test(t.text)));
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
  const segments = children(board, 'segment');
  assert.equal(segments.filter((n) => val(child(n, 'locked')) === 'yes').length, 130);
  for (const net of ['SNA', 'SNB'])
    assert.equal(segments.filter((n) => val(child(n, 'net')) === net).length, 1, net);
  for (const segment of segments) {
    const [start, end] = ['start', 'end'].map((key) =>
      [1, 2].map((i) => Math.round(Number(val(child(segment, key), i)) * 1e6)),
    );
    const dx = Math.abs(end[0] - start[0]);
    const dy = Math.abs(end[1] - start[1]);
    assert.ok((dx || dy) && (!dx || !dy || dx === dy), val(child(segment, 'uuid')));
  }
  const nativeCopy = projectFromNativeFiles(bundle);
  assert.equal(nativeCopy.pcb!.footprints.length, 88);
  assert.equal(Object.hasOwn(nativeCopy.extensions, 'org.openpe.enclosure'), false);
  assert.deepEqual(modelCadFromProject(nativeCopy), cadA);
  const settings = JSON.parse(
    bundle.files.find((file) => file.name.endsWith('.kicad_pro'))!.source,
  );
  assert.ok(!('OPENPE_ENCLOSURE' in settings.text_variables));
  assert.deepEqual(JSON.parse(settings.text_variables[MODEL_CAD_NATIVE_VARIABLE]), cadA);
});

test('EMC enclosure uses Model sketch differences with exact panel bounds, materials and cut contours', () => {
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
      cuts: panelCuts(body),
    })),
    [
      {
        kind: 'boolean',
        size: { x: 112, y: 94, z: 3 },
        position: { x: 100, y: 88, z: -10.3 },
        rotation: { x: 0, y: 0, z: 0 },
        material: 'aluminium',
        opacity: 1,
        cuts: [
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
        cuts: [],
      })),
      {
        kind: 'boolean',
        size: { x: 112, y: 94, z: 3 },
        position: { x: 100, y: 88, z: 22.7 },
        rotation: { x: 0, y: 0, z: 0 },
        material: 'pmma',
        opacity: 0.3,
        cuts: [
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

test('EMC enclosure exists only in Model CAD, outside PCB footprints and project footprint libraries', () => {
  const project = createHomeExample('emc-flyback-demo');
  const original = parseSExpr(
    readFileSync(
      'resources/example-catalog/sources/emc-flyback/design/emc_flyback.kicad_pcb',
      'utf8',
    ),
  );
  const generated = parseSExpr(
    readFileSync('examples/project/emc-flyback/emc-flyback.kicad_pcb', 'utf8'),
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
  for (const ref of ['MECH1', 'MECH2']) {
    const before = children(original, 'footprint').find((fp) => reference(fp) === ref)!,
      after = children(generated, 'footprint').find((fp) => reference(fp) === ref);
    assert.ok(before, 'Original upstream enclosure evidence remains pinned.');
    assert.equal(children(before, 'pad').length, 0);
    assert.equal(after, undefined);
    assert.equal(
      project.pcb!.footprints.some((fp) => fp.reference === ref),
      false,
    );
  }
  const native = projectNativeFiles(project);
  assert.equal(
    native.files.some((file) =>
      /(?:Case_UChannel_revD|Cover_PMMA_revD)\.kicad_mod$/.test(file.name),
    ),
    false,
  );
  for (const name of ['Case_UChannel_revD', 'Cover_PMMA_revD'])
    assert.equal(
      existsSync(`examples/project/emc-flyback/footprints/emc-flyback.pretty/${name}.kicad_mod`),
      false,
    );
  assert.equal(modelCadFromProject(project)!.objects.length, 4);
  const before = parseSExpr(
    readFileSync('tests/fixtures/emc-track-drag-kicad10-source.kicad_pcb', 'utf8'),
  );
  const placements = new Map(Object.entries(layout.placements));
  for (const fp of children(before, 'footprint')) {
    const position = placements.get(reference(fp));
    if (position) child(fp, 'at')!.splice(1, 2, ...position.map(String));
  }
  const tracks = new Map<string, { points: number[][]; additionalIds?: string[] }>(
    Object.entries(layout.tracks),
  );
  for (const segment of children(before, 'segment')) {
    const id = val(child(segment, 'uuid'));
    if (layout.removedTracks.includes(id)) {
      before.splice(before.indexOf(segment), 1);
      continue;
    }
    const route = tracks.get(id);
    if (!route) continue;
    const { points, additionalIds = [] } = route;
    const expectedLegs = [id, ...additionalIds].map((legId, index) => {
      const leg = structuredClone(segment);
      child(leg, 'uuid')![1] = quote(legId);
      child(leg, 'start')!.splice(1, 2, ...points[index].map(String));
      child(leg, 'end')!.splice(1, 2, ...points[index + 1].map(String));
      return leg;
    });
    before.splice(before.indexOf(segment), 1, ...expectedLegs);
  }
  const withoutCasesOrFills = (board: ReturnType<typeof parseSExpr>) =>
    board.filter(
      (node) =>
        !Array.isArray(node) ||
        node[0] !== 'footprint' ||
        !['MECH1', 'MECH2'].includes(reference(node)),
    ).map((node) =>
      Array.isArray(node) && node[0] === 'zone'
        ? node.filter((item) => !Array.isArray(item) || item[0] !== 'filled_polygon')
        : node,
    );
  const expected = withoutCasesOrFills(before);
  const actual = withoutCasesOrFills(generated);
  assert.equal(actual.length, expected.length);
  for (const [index, record] of expected.entries())
    assert.deepEqual(actual[index], record, `Unexpected change to native PCB record ${index}.`);
});

test('native schematic note outlines reject unsupported or malformed geometry', () => {
  const source = parseSExpr(
    readFileSync('examples/project/emc-flyback/emc-flyback.kicad_sch', 'utf8'),
  );
  const line = children(source, 'polyline')[0];
  child(child(line, 'pts')!, 'xy')![1] = 'NaN';
  assert.throws(() => schematicPolylines(source), /Unsupported schematic polyline/);
});
