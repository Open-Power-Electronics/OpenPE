import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCircuit, parseCircuit, uid, type Circuit, type Wire } from '../lib/circuit';
import {
  createProject,
  exportKiCad,
  parseProject,
  schematicDocumentItems,
  serializeProject,
} from '../lib/project';
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';
import { commitWireRoute, samePoint } from '../lib/wiring';

function fixture() {
  const source = emptyCircuit();
  source.title = 'Styled wire join';
  const styled: Wire = {
    id: uid(),
    a: { x: 0.111, y: 2.343 },
    b: { x: 10.333, y: 2.343 },
  };
  styled.raw = [
    'wire',
    ['uuid', quote(styled.id)],
    ['stroke', ['width', '0.254'], ['type', 'dash'], ['color', '25', '50', '75', '0.75']],
    ['pts', ['xy', '0.111', '2.343'], ['xy', '10.333', '2.343']],
  ];
  source.wires = [styled, { id: uid(), a: { x: 0, y: 20.32 }, b: { x: 5.08, y: 20.32 } }];
  return parseCircuit(exportKiCad(createProject(source), 'schematic'));
}
const metadata = (wire: Wire) =>
  wire.raw?.filter((node) => !Array.isArray(node) || !['pts', 'uuid'].includes(String(node[0])));
const ids = (doc: Circuit) => doc.wires.map((wire) => wire.id);

test('off-grid branch joins preserve every split wire style, fresh raw UUIDs and unique native order', () => {
  const source = fixture(),
    before = structuredClone(source),
    project = createProject(source),
    otherSheet = emptyCircuit();
  otherSheet.title = 'Independent schematic';
  project.additionalSchematics = [otherSheet];
  const canonicalBefore = serializeProject(project),
    join = { x: 5.3, y: 2.343 },
    branchStart = { x: join.x, y: -3.81 },
    next = commitWireRoute(source, [branchStart, join]),
    horizontal = next.wires.filter((wire) => wire.a.y === join.y && wire.b.y === join.y),
    committedProject = { ...project, schematic: next },
    canonical = serializeProject(committedProject),
    document = JSON.parse(canonical),
    drawing = schematicDocumentItems(document.schematic, 'wires');

  assert.deepEqual(source, before, 'The entire source working model remains unchanged.');
  assert.equal(
    serializeProject(project),
    canonicalBefore,
    'Joining cannot mutate canonical source bytes.',
  );
  assert.deepEqual(committedProject.additionalSchematics, project.additionalSchematics);
  assert.equal(next.wires.length, 4);
  assert.equal(horizontal.length, 2);
  assert.equal(
    horizontal[0].id,
    source.wires[0].id,
    'The first split keeps its original identity.',
  );
  assert.notEqual(horizontal[1].id, source.wires[0].id);
  assert.deepEqual(horizontal[0].a, source.wires[0].a);
  assert.deepEqual(horizontal[0].b, join);
  assert.deepEqual(horizontal[1].a, join);
  assert.deepEqual(horizontal[1].b, source.wires[0].b);
  assert.notEqual(
    horizontal[0].raw,
    horizontal[1].raw,
    'Derivative metadata owns independent storage.',
  );
  assert.notEqual(horizontal[0].raw, source.wires[0].raw);
  for (const wire of horizontal) {
    assert.deepEqual(metadata(wire), metadata(source.wires[0]));
    assert.equal(val(child(wire.raw!, 'uuid')), wire.id);
    assert.equal(children(wire.raw!, 'uuid').length, 1);
  }
  assert.deepEqual(
    next.wires[2],
    source.wires[1],
    'Unrelated wire metadata and order remain intact.',
  );
  assert.ok(next.junctions.some((junction) => samePoint(junction, join)));
  assert.equal(new Set(ids(next)).size, next.wires.length);
  assert.deepEqual(
    drawing.map((wire) => wire.id),
    ids(next),
  );
  assert.deepEqual(
    drawing.map((wire) => wire.order),
    [0, 1, 2, 3],
  );

  const native = exportKiCad(committedProject, 'schematic');
  assert.deepEqual(
    children(parseSExpr(native), 'wire').map((wire) => val(child(wire, 'uuid'))),
    ids(next),
  );
  for (const roundtrip of [parseProject(canonical).schematic, parseCircuit(native)]) {
    assert.deepEqual(ids(roundtrip), ids(next));
    assert.deepEqual(
      roundtrip.wires.map(({ a, b }) => ({ a, b })),
      next.wires.map(({ a, b }) => ({ a, b })),
    );
    for (const wire of horizontal) {
      const reopened = roundtrip.wires.find((item) => item.id === wire.id)!;
      assert.deepEqual(metadata(reopened), metadata(source.wires[0]));
      assert.equal(val(child(reopened.raw!, 'uuid')), wire.id);
    }
    assert.equal(new Set(ids(roundtrip)).size, roundtrip.wires.length);
  }
});

test('multiple branch checkpoints clone metadata for every derivative without retaining duplicate UUIDs', () => {
  const source = fixture(),
    next = commitWireRoute(source, [
      { x: 2.3, y: -2.54 },
      { x: 2.3, y: 2.343 },
      { x: 8.7, y: 2.343 },
      { x: 8.7, y: -2.54 },
    ]),
    horizontal = next.wires.filter((wire) => wire.a.y === 2.343 && wire.b.y === 2.343);
  assert.equal(horizontal.length, 3);
  assert.equal(horizontal[0].id, source.wires[0].id);
  for (const wire of horizontal) {
    assert.deepEqual(metadata(wire), metadata(source.wires[0]));
    assert.equal(val(child(wire.raw!, 'uuid')), wire.id);
  }
  assert.equal(new Set(ids(next)).size, next.wires.length);
  parseProject(serializeProject(createProject(next)));
});

test('a reversed source wire keeps its first native identity in source endpoint order', () => {
  const source = fixture(),
    wire = source.wires[0];
  [wire.a, wire.b] = [wire.b, wire.a];
  const before = structuredClone(source),
    join = { x: 5.3, y: 2.343 },
    next = commitWireRoute(source, [{ x: join.x, y: -3.81 }, join]),
    horizontal = next.wires.filter((item) => item.a.y === join.y && item.b.y === join.y);
  assert.equal(horizontal[0].id, wire.id);
  assert.deepEqual(horizontal[0].a, wire.a);
  assert.deepEqual(horizontal[0].b, join);
  assert.deepEqual(horizontal[1].a, join);
  assert.deepEqual(horizontal[1].b, wire.b);
  for (const item of horizontal) {
    assert.deepEqual(metadata(item), metadata(wire));
    assert.equal(val(child(item.raw!, 'uuid')), item.id);
  }
  assert.deepEqual(source, before);
  const roundtrip = parseProject(serializeProject(createProject(next))).schematic;
  assert.deepEqual(ids(roundtrip), ids(next));
});

test('empty and zero-length route proposals preserve source geometry and canonical bytes', () => {
  const source = fixture();
  source.wires.push({ id: uid(), a: { x: 20.32, y: 20.32 }, b: { x: 20.32, y: 20.32 } });
  const before = structuredClone(source),
    project = createProject(source),
    canonical = serializeProject(project),
    interior = { x: 5.3, y: 2.343 };
  for (const points of [
    [],
    [interior],
    [interior, interior],
    [interior, { x: interior.x + 0.00001, y: interior.y }],
  ]) {
    const next = commitWireRoute(source, points);
    assert.deepEqual(
      next,
      before,
      'A no-op must not split source wires or remove degenerate source objects.',
    );
    assert.equal(serializeProject({ ...project, schematic: next }), canonical);
  }
  assert.deepEqual(source, before);
});

test('duplicate new route legs are suppressed without deleting existing coincident or zero-length source wires', () => {
  const source = fixture(),
    duplicate = structuredClone(source.wires[0]);
  duplicate.id = uid();
  child(duplicate.raw!, 'uuid')![1] = quote(duplicate.id);
  child(child(duplicate.raw!, 'stroke')!, 'color')![1] = '125';
  source.wires.push(duplicate, { id: uid(), a: { x: 20.32, y: 20.32 }, b: { x: 20.32, y: 20.32 } });
  const before = structuredClone(source),
    project = createProject(source),
    canonical = serializeProject(project),
    duplicateRoute = commitWireRoute(source, [
      source.wires[0].a,
      source.wires[0].b,
      source.wires[0].a,
    ]);
  assert.deepEqual(duplicateRoute, before);
  assert.equal(serializeProject({ ...project, schematic: duplicateRoute }), canonical);

  const next = commitWireRoute(source, [
    { x: 30.48, y: 30.48 },
    { x: 40.64, y: 30.48 },
  ]);
  assert.deepEqual(next.wires.slice(0, source.wires.length), source.wires);
  assert.equal(next.wires.length, source.wires.length + 1);
  assert.deepEqual(source, before);
  parseProject(serializeProject({ ...project, schematic: next }));
});
