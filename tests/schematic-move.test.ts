import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  uid,
  type Circuit,
  type Point,
} from '../lib/circuit';
import {
  fieldId,
  moveSelection,
  objectPosition,
  saveAnnotation,
  transformSelection,
} from '../lib/schematic-edit';
import { previewSchematicMove, type SchematicMoveOperation } from '../lib/schematic-move';
import { createProject, exportKiCad, parseProject, serializeProject } from '../lib/project';
import { projectNetGroups } from '../lib/project-net-groups';
import { child, children, val } from '../lib/sexpr';
import { onWire, samePoint } from '../lib/wiring';
import { ownProject } from '../lib/immutable-project';

const topology = (doc: Circuit) =>
  projectNetGroups(doc)
    .map((group) => [...group.pins].sort())
    .filter((pins) => pins.length)
    .sort();
const at = (point: Point) => ({ x: point.x, y: point.y });
const transformed = (
  point: Point,
  anchor: Point,
  target: Point,
  operations: SchematicMoveOperation[],
) => {
  let next = at(point);
  for (const operation of operations)
    next =
      operation === 'rotate'
        ? { x: anchor.x + next.y - anchor.y, y: anchor.y - next.x + anchor.x }
        : operation === 'rotateReverse'
          ? { x: anchor.x - next.y + anchor.y, y: anchor.y + next.x - anchor.x }
          : operation === 'mirrorX'
            ? { x: next.x, y: 2 * anchor.y - next.y }
            : { x: 2 * anchor.x - next.x, y: next.y };
  return {
    x: Number((next.x + target.x - anchor.x).toFixed(4)),
    y: Number((next.y + target.y - anchor.y).toFixed(4)),
  };
};
function fixture() {
  const source = emptyCircuit();
  source.parts.push(createPart(source, 'R', 25.4, 25.4), createPart(source, 'C', 76.2, 25.4));
  for (const part of source.parts) part.rotation = 180;
  const [a, b] = source.parts.map((part) => pinPositions(part, source.libraries[part.libId])[0]);
  source.wires = [
    { id: uid(), a, b: { x: a.x, y: 40.64 } },
    { id: uid(), a: { x: a.x, y: 40.64 }, b: { x: b.x, y: 40.64 } },
    { id: uid(), a: { x: b.x, y: 40.64 }, b },
  ];
  source.labels = [{ id: uid(), x: 50.8, y: 40.64, text: 'SIGNAL' }];
  return parseCircuit(exportKiCad(createProject(source), 'schematic'));
}

test('floating M moves selected symbols and whole wire segments while leaving unselected geometry untouched', () => {
  const source = fixture(),
    before = structuredClone(source),
    part = source.parts[0],
    wire = source.wires[1],
    anchor = { x: 26.17, y: 24.63 },
    target = { x: 31.25, y: 27.17 },
    preview = previewSchematicMove(source, [part.id, wire.id], anchor, target);
  assert.deepEqual(at(preview.parts[0]), { x: 30.48, y: 27.94 });
  assert.deepEqual(preview.parts[1], source.parts[1]);
  assert.deepEqual(
    preview.wires.filter((item) => item.id !== wire.id),
    source.wires.filter((item) => item.id !== wire.id),
  );
  assert.deepEqual(preview.wires[1].a, transformed(wire.a, anchor, target, []));
  assert.deepEqual(preview.wires[1].b, transformed(wire.b, anchor, target, []));
  assert.deepEqual(preview.labels, source.labels);
  assert.deepEqual(preview.wires[1].raw, wire.raw);
  assert.deepEqual(source, before);
});

test('immutable gesture poses retain unrelated symbols and native content without changing generic edit isolation', () => {
  const source = ownProject(createProject(fixture())).schematic;
  const before = structuredClone(source);
  const part = source.parts[0];
  const target = { x: part.x + 5.08, y: part.y + 2.54 };
  for (const connected of [false, true]) {
    const preview = previewSchematicMove(source, [part.id], at(part), target, [], connected);
    assert.notEqual(preview.parts[0], source.parts[0]);
    assert.equal(preview.parts[1], source.parts[1]);
    assert.equal(preview.libraries, source.libraries);
    assert.equal(preview.original, source.original);
    if (!connected) {
      assert.equal(preview.wires[0], source.wires[0]);
      assert.equal(preview.labels[0], source.labels[0]);
    } else assert.deepEqual(topology(preview), topology(source));
  }
  const generic = moveSelection(source, [part.id], { x: 5.08, y: 2.54 }, true);
  assert.notEqual(generic.parts[1], source.parts[1]);
  assert.notEqual(generic.libraries, source.libraries);
  generic.parts[1].value = 'Detached caller edit';
  const nudge = moveSelection(source, [part.id], { x: 5.08, y: 2.54 }, true, true);
  assert.equal(nudge.parts[1], source.parts[1]);
  assert.equal(nudge.libraries, source.libraries);
  assert.equal(nudge.original, source.original);
  assert.deepEqual(topology(nudge), topology(source));
  assert.ok(Math.abs(nudge.parts[0].x - part.x - 5.08) < 1e-10);
  assert.ok(Math.abs(nudge.parts[0].y - part.y - 2.54) < 1e-10);
  assert.deepEqual(source, before);
});

test('floating group operations use the pickup anchor and preserve relative geometry and every selected identity', () => {
  let source = fixture();
  source.parts[0].mirror = 'y';
  source.labels.push({ id: uid(), x: 38.1, y: 45.72, text: 'SELECTED', rotation: 90 });
  source.noConnects = [{ id: uid(), x: 12.7, y: 50.8 }];
  const note = saveAnnotation(source, 'Selected note', { x: 20.32, y: 50.8 });
  source = note.circuit;
  const selectedLabel = source.labels[1],
    selectedWire = source.wires[1],
    ids = [
      source.parts[0].id,
      source.parts[1].id,
      selectedWire.id,
      selectedLabel.id,
      source.noConnects![0].id,
      note.id,
    ],
    anchor = { x: 26.035, y: 26.67 },
    target = { x: 43.815, y: 36.83 },
    operations: SchematicMoveOperation[] = ['rotate', 'mirrorX', 'rotateReverse'],
    preview = previewSchematicMove(source, ids, anchor, target, operations),
    before = structuredClone(source);
  for (const original of source.parts) {
    const result = preview.parts.find((part) => part.id === original.id)!;
    assert.deepEqual(at(result), transformed(original, anchor, target, operations));
    const pins = pinPositions(original, source.libraries[original.libId]);
    assert.deepEqual(
      pinPositions(result, preview.libraries[result.libId]),
      pins.map((pin) => transformed(pin, anchor, target, operations)),
    );
    assert.deepEqual(result.fields, original.fields);
    assert.deepEqual(result.raw, original.raw);
  }
  assert.deepEqual(preview.wires[1].a, transformed(selectedWire.a, anchor, target, operations));
  assert.deepEqual(preview.wires[1].b, transformed(selectedWire.b, anchor, target, operations));
  assert.deepEqual(at(preview.labels[1]), transformed(selectedLabel, anchor, target, operations));
  assert.equal(preview.labels[1].rotation, selectedLabel.rotation);
  assert.deepEqual(
    at(preview.noConnects![0]),
    transformed(source.noConnects![0], anchor, target, operations),
  );
  assert.deepEqual(
    at(objectPosition(preview, note.id)!),
    transformed(objectPosition(source, note.id)!, anchor, target, operations),
  );
  assert.deepEqual(preview.wires[0], source.wires[0]);
  assert.deepEqual(preview.labels[0], source.labels[0]);
  assert.deepEqual(source, before);
});

test('clockwise and counterclockwise transforms invert at a supplied pivot for mirrored symbols and groups', () => {
  const source = fixture(),
    ids = [...source.parts, ...source.wires, ...source.labels].map((item) => item.id),
    pivot = { x: 12.065, y: 13.335 };
  source.parts[0].mirror = 'x';
  const forward = transformSelection(source, ids, 'rotate', pivot),
    reverse = transformSelection(forward, ids, 'rotateReverse', pivot);
  assert.deepEqual(reverse, source);
  assert.deepEqual(at(forward.parts[0]), transformed(source.parts[0], pivot, pivot, ['rotate']));
  assert.deepEqual(
    previewSchematicMove(source, ids, pivot, pivot, ['rotate', 'rotateReverse'], true),
    source,
  );
  assert.deepEqual(
    previewSchematicMove(source, ids, pivot, pivot, ['mirrorX', 'mirrorX'], true),
    source,
  );
});

test('connected G translation carries attached labels and no-connects using the original graph', () => {
  const source = fixture(),
    part = source.parts[0],
    pins = pinPositions(part, source.libraries[part.libId]);
  source.labels.push({ id: uid(), ...pins[0], text: 'INPUT' });
  source.noConnects = [{ id: uid(), ...pins[1] }];
  const anchor = at(part),
    target = { x: part.x + 5.08, y: part.y + 2.54 },
    before = structuredClone(source),
    preview = previewSchematicMove(source, [part.id], anchor, target, [], true),
    nextPins = pinPositions(preview.parts[0], preview.libraries[part.libId]);
  assert.ok(samePoint(preview.labels[1], nextPins[0]));
  assert.ok(samePoint(preview.noConnects![0], nextPins[1]));
  assert.deepEqual(topology(preview), topology(source));
  assert.deepEqual(
    new Set(preview.wires.map((wire) => wire.id)),
    new Set(source.wires.map((wire) => wire.id)),
  );
  assert.deepEqual(source, before);
});

test('connected G rotations and mirrors reroute matching original pin indexes while keeping fixed pins and incidental crossings', () => {
  for (const operations of [
    ['rotate'],
    ['rotateReverse'],
    ['mirrorX'],
    ['rotate', 'mirrorY'],
  ] as SchematicMoveOperation[][]) {
    const source = fixture(),
      part = source.parts[0],
      pins = pinPositions(part, source.libraries[part.libId]),
      crossing = { id: uid(), a: { x: 63.5, y: 35.56 }, b: { x: 63.5, y: 55.88 } };
    source.wires.push(crossing);
    source.labels.push({ id: uid(), ...pins[0], text: 'INPUT' });
    source.noConnects = [{ id: uid(), ...pins[1] }];
    const preview = previewSchematicMove(
        source,
        [part.id],
        at(part),
        { x: 30.48, y: 27.94 },
        operations,
        true,
      ),
      nextPins = pinPositions(preview.parts[0], preview.libraries[part.libId]);
    assert.ok(
      preview.wires.some(
        (wire) => samePoint(wire.a, nextPins[0]) || samePoint(wire.b, nextPins[0]),
      ),
    );
    assert.ok(samePoint(preview.labels[1], nextPins[0]));
    assert.ok(samePoint(preview.noConnects![0], nextPins[1]));
    assert.deepEqual(preview.parts[1], source.parts[1]);
    assert.deepEqual(
      preview.wires.find((wire) => wire.id === crossing.id),
      crossing,
    );
    assert.deepEqual(
      topology(preview),
      topology(source),
      JSON.stringify({ operations, wires: preview.wires, pins: nextPins }),
    );
    assert.ok(preview.wires.every((wire) => wire.a.x === wire.b.x || wire.a.y === wire.b.y));
    for (const round of [
      parseProject(serializeProject(createProject(preview))).schematic,
      parseCircuit(exportKiCad(createProject(preview), 'schematic')),
    ])
      assert.deepEqual(topology(round), topology(source));
  }
});

test('rotating a connected selected wire carries interior anchors while keeping stationary component pins', () => {
  const source = fixture(),
    selected = source.wires[1],
    anchor = { x: 50.8, y: 40.64 },
    operations: SchematicMoveOperation[] = ['rotate'],
    preview = previewSchematicMove(source, [selected.id], anchor, anchor, operations, true);
  assert.deepEqual(preview.parts, source.parts);
  assert.ok(
    samePoint(preview.labels[0], transformed(source.labels[0], anchor, anchor, operations)),
  );
  assert.ok(preview.wires.some((wire) => wire.id === selected.id));
  assert.deepEqual(topology(preview), topology(source));
  assert.ok(preview.wires.some((wire) => onWire(preview.labels[0], wire)));
});

test('connected rotation and mirroring preserve a stationary pin shared with a moved component', () => {
  for (const operations of [['rotate'], ['mirrorX']] as SchematicMoveOperation[][]) {
    const source = fixture(),
      part = source.parts[0],
      stationary = createPart(source, 'C', part.x, part.y);
    stationary.rotation = part.rotation;
    source.parts.push(stationary);
    const preview = previewSchematicMove(
        source,
        [part.id],
        at(part),
        { x: part.x + 5.08, y: part.y },
        operations,
        true,
      ),
      pin = pinPositions(stationary, source.libraries[stationary.libId])[0];
    assert.deepEqual(preview.parts[2], stationary);
    assert.ok(preview.wires.some((wire) => onWire(pin, wire)));
    assert.deepEqual(
      topology(preview),
      topology(source),
      JSON.stringify({ operations, wires: preview.wires }),
    );
  }
});

test('a connected mirror detour avoids an unrelated wire endpoint regardless of native wire order', () => {
  for (const first of [false, true]) {
    const source = fixture(),
      part = source.parts[0],
      foreign = { id: uid(), a: { x: 29.21, y: 21.59 }, b: { x: 27.94, y: 21.59 } };
    if (first) source.wires.unshift(foreign);
    else source.wires.push(foreign);
    const preview = previewSchematicMove(
      source,
      [part.id],
      at(part),
      { x: part.x + 5.08, y: part.y },
      ['mirrorX'],
      true,
    );
    assert.deepEqual(
      preview.wires.find((wire) => wire.id === foreign.id),
      foreign,
    );
    assert.ok(
      preview.wires
        .filter((wire) => wire.id !== foreign.id)
        .every(
          (wire) =>
            !onWire(foreign.a, wire) &&
            !onWire(foreign.b, wire) &&
            !onWire(wire.a, foreign) &&
            !onWire(wire.b, foreign),
        ),
    );
    assert.deepEqual(topology(preview), topology(source));
  }
});

test('pointer previews reuse an immutable source after fixture setup and index new transaction objects separately', () => {
  const source = fixture(),
    part = source.parts[0],
    foreign = { id: uid(), a: { x: 29.21, y: 21.59 }, b: { x: 27.94, y: 21.59 } };
  // Fixture setup may mutate a new document before its first preview. Once a
  // gesture starts, the editor keeps that exact source snapshot immutable.
  source.wires.push(foreign);
  const before = structuredClone(source);
  const freeze = (value: unknown) => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(source);
  for (const target of [
    { x: 30.48, y: 25.4 },
    { x: 31.75, y: 26.67 },
    { x: 33.02, y: 27.94 },
  ]) {
    const preview = previewSchematicMove(source, [part.id], at(part), target, ['mirrorX'], true);
    assert.deepEqual(topology(preview), topology(source));
    assert.ok(
      preview.wires
        .filter((wire) => wire.id !== foreign.id)
        .every(
          (wire) =>
            !onWire(foreign.a, wire) &&
            !onWire(foreign.b, wire) &&
            !onWire(wire.a, foreign) &&
            !onWire(wire.b, foreign),
        ),
    );
  }
  const nextSource = structuredClone(source),
    nextForeign = { id: uid(), a: { x: 31.75, y: 21.59 }, b: { x: 33.02, y: 21.59 } };
  nextSource.wires.push(nextForeign);
  freeze(nextSource);
  const nextPreview = previewSchematicMove(
    nextSource,
    [part.id],
    at(part),
    { x: 30.48, y: 25.4 },
    ['mirrorX'],
    true,
  );
  assert.deepEqual(topology(nextPreview), topology(nextSource));
  for (const obstacle of [foreign, nextForeign])
    assert.ok(
      nextPreview.wires
        .filter((wire) => ![foreign.id, nextForeign.id].includes(wire.id))
        .every(
          (wire) =>
            !onWire(obstacle.a, wire) &&
            !onWire(obstacle.b, wire) &&
            !onWire(wire.a, obstacle) &&
            !onWire(wire.b, obstacle),
        ),
    );
  assert.deepEqual(source, before);
});

test('a failed source grouping is not cached and a corrected source can retry', () => {
  const source = fixture(),
    part = source.parts[0],
    wires = [...source.wires];
  source.wires.push(
    ...Array.from({ length: 15000 }, (_, index) => ({
      id: uid(),
      a: { x: index + 1000, y: 1000 },
      b: { x: index + 1000, y: 1001 },
    })),
  );
  const target = { x: part.x + 5.08, y: part.y + 2.54 };
  assert.throws(
    () => previewSchematicMove(source, [part.id], at(part), target, [], true),
    /30,000/,
  );
  source.wires = wires;
  const preview = previewSchematicMove(source, [part.id], at(part), target, [], true);
  assert.deepEqual(topology(preview), topology(source));
});

test('generic connected editing reindexes a mutable source on every call', () => {
  const source = fixture(),
    part = source.parts[0],
    wires = [...source.wires],
    delta = { x: 5.08, y: 2.54 };
  assert.deepEqual(topology(moveSelection(source, [part.id], delta, true)), topology(source));
  source.wires.push(
    ...Array.from({ length: 15000 }, (_, index) => ({
      id: uid(),
      a: { x: index + 1000, y: 1000 },
      b: { x: index + 1000, y: 1001 },
    })),
  );
  assert.throws(() => moveSelection(source, [part.id], delta, true), /30,000/);
  source.wires = wires;
  const stationary = createPart(source, 'C', part.x, part.y);
  stationary.rotation = part.rotation;
  source.parts.push(stationary);
  source.junctions.push({ id: uid(), ...pinPositions(part, source.libraries[part.libId])[0] });
  assert.deepEqual(topology(moveSelection(source, [part.id], delta, true)), topology(source));
});

test('connected movement can reach an already connected pin through another source segment', () => {
  const source = emptyCircuit(),
    selected = createPart(source, 'Port', 25.4, 25.4);
  source.parts.push(selected);
  const stationary = createPart(source, 'Port', 76.2, 25.4);
  source.parts.push(stationary);
  const [a, b] = source.parts.map((part) => pinPositions(part, source.libraries[part.libId])[0]);
  source.wires = [
    { id: uid(), a, b: { x: a.x, y: 40.64 } },
    { id: uid(), a: { x: a.x, y: 40.64 }, b: { x: b.x, y: 40.64 } },
    { id: uid(), a: { x: b.x, y: 40.64 }, b },
  ];
  const before = structuredClone(source),
    preview = previewSchematicMove(source, [selected.id], at(selected), at(stationary), [], true);
  assert.ok(samePoint(pinPositions(preview.parts[0], preview.libraries[selected.libId])[0], b));
  assert.deepEqual(preview.parts[1], stationary);
  assert.deepEqual(topology(preview), topology(source));
  assert.deepEqual(source, before);
});

test('independent fields and notes move without rerouting and redundant owner fields do not move twice', () => {
  const source = fixture(),
    part = source.parts[0],
    field = fieldId(part.id, 'Reference'),
    position = objectPosition(source, field)!,
    anchor = at(position),
    target = { x: position.x + 2.54, y: position.y + 1.27 },
    preview = previewSchematicMove(source, [field], anchor, target, ['rotate'], true);
  assert.ok(samePoint(objectPosition(preview, field)!, target));
  assert.deepEqual(preview.wires, source.wires);
  assert.deepEqual(
    pinPositions(preview.parts[0], preview.libraries[part.libId]),
    pinPositions(part, source.libraries[part.libId]),
  );
  const owner = previewSchematicMove(source, [part.id, field, part.id], at(part), {
    x: part.x + 2.54,
    y: part.y + 1.27,
  });
  assert.deepEqual(
    owner,
    previewSchematicMove(source, [part.id], at(part), { x: part.x + 2.54, y: part.y + 1.27 }),
  );
});

test('the exact preview remains a valid commit payload with unique retained native metadata and no source mutation', () => {
  const source = fixture(),
    part = source.parts[0],
    before = structuredClone(source),
    preview = previewSchematicMove(
      source,
      [part.id],
      at(part),
      { x: 34.29, y: 31.75 },
      ['rotate'],
      true,
    ),
    json = serializeProject(createProject(preview)),
    native = exportKiCad(createProject(preview), 'schematic');
  assert.deepEqual(new Set(preview.wires.map((wire) => wire.id)).size, preview.wires.length);
  for (const original of source.wires)
    assert.ok(preview.wires.some((wire) => wire.id === original.id));
  for (const wire of preview.wires)
    if (wire.raw) assert.equal(val(child(wire.raw, 'uuid')), wire.id);
  const rawPart = children(preview.original!, 'symbol').find(
    (node) => val(child(node, 'uuid')) === part.id,
  )!;
  assert.deepEqual(
    rawPart,
    children(before.original!, 'symbol').find((node) => val(child(node, 'uuid')) === part.id),
  );
  assert.deepEqual(topology(parseProject(json).schematic), topology(preview));
  assert.deepEqual(topology(parseCircuit(native)), topology(preview));
  assert.deepEqual(source, before);
});

test('invalid movement coordinates fail before changing the source document', () => {
  const source = fixture(),
    before = structuredClone(source);
  assert.throws(
    () => previewSchematicMove(source, [source.parts[0].id], { x: NaN, y: 0 }, { x: 0, y: 0 }),
    /finite/,
  );
  assert.throws(
    () => previewSchematicMove(source, [source.parts[0].id], { x: 0, y: 0 }, { x: Infinity, y: 0 }),
    /finite/,
  );
  assert.deepEqual(source, before);
});
