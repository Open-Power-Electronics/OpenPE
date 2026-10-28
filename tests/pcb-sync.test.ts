import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPart,
  emptyCircuit,
  pinPositions,
  uid,
  type Circuit,
  type Point,
} from '../lib/circuit';
import { parseSExpr, child, children } from '../lib/sexpr';
import { createProject, parseProject, serializeProject } from '../lib/project';
import { flipPCBFootprint } from '../lib/pcb-layout';
import {
  pcbPinKey,
  pcbUpdateFootprintIds,
  schematicPCBNets,
  updatePCBFromSchematic,
} from '../lib/pcb-sync';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import { ownProjectData } from '../lib/immutable-project';

const detail = {
  id: 'Test:TwoPin',
  footprint: parseSExpr(`(footprint "TwoPin" (layer "F.Cu")
  (pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask"))
  (pad "2" thru_hole circle (at 2.54 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")))`),
};
const sources = new Map([[detail.id, detail]]);
function fixture() {
  const circuit = emptyCircuit();
  const p = createPart(circuit, 'R', 10.16, 10.16);
  p.fields = { Footprint: detail.id };
  circuit.parts.push(p);
  const pins = pinPositions(p, circuit.libraries[p.libId]);
  circuit.labels = pins.map((pin, i) => ({ ...pin, id: uid(), text: i ? 'OUT' : 'IN' }));
  return { circuit, p, pins };
}
test('assigned footprints and physical nets are materialized without mutating the schematic; repeated sync is clean', () => {
  const { circuit } = fixture(),
    before = structuredClone(circuit);
  const first = updatePCBFromSchematic(circuit, undefined, sources);
  assert.equal(first.added, 1);
  assert.equal(first.board.footprints.length, 1);
  assert.deepEqual(
    first.board.nets.map((n) => n.name),
    ['IN', 'OUT'],
  );
  assert.ok(first.board.footprints[0].pads.every((p) => p.netId));
  assert.deepEqual(circuit, before);
  assert.deepEqual(pcbUpdateFootprintIds(circuit, first.board), []);
  const second = updatePCBFromSchematic(circuit, first.board, new Map());
  assert.equal(second.changed, false);
  assert.equal(second.board, first.board);
  const project = { ...createProject(circuit), pcb: first.board };
  assert.deepEqual(parseProject(serializeProject(project)).pcb, first.board);
});

test('physical no-op updates retain complete owned boards and fills while changed pin nets invalidate them', () => {
  const { circuit } = fixture();
  const board = updatePCBFromSchematic(circuit, undefined, sources).board;
  board.zones.push({
    id: uid(),
    netId: board.nets[0].id,
    layer: 'F.Cu',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    filledPolygons: [
      {
        points: [
          { x: 1, y: 1 },
          { x: 9, y: 1 },
          { x: 9, y: 9 },
        ],
      },
    ],
    clearance: 0.2,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  });
  const owned = ownProjectData(board);
  const translated = ownProjectData({
    ...circuit,
    parts: circuit.parts.map((part) => ({ ...part, x: part.x + 1.27 })),
    labels: circuit.labels.map((label) => ({ ...label, x: label.x + 1.27 })),
  });
  const repeated = updatePCBFromSchematic(translated, owned, new Map());
  assert.equal(repeated.changed, false);
  assert.equal(repeated.board, owned);
  assert.equal(repeated.board.zones[0].filledPolygons, owned.zones[0].filledPolygons);

  const renamed = ownProjectData({
    ...translated,
    labels: translated.labels.map((label, index) => (index ? label : { ...label, text: 'VIN' })),
  });
  const caption = updatePCBFromSchematic(renamed, owned, new Map());
  assert.equal(caption.changed, true);
  assert.equal(caption.board.footprints, owned.footprints);
  assert.equal(caption.board.tracks, owned.tracks);
  assert.equal(caption.board.zones[0].filledPolygons, owned.zones[0].filledPolygons);
  assert.ok(caption.board.nets.some((net) => net.name === 'VIN'));

  const disconnected = ownProjectData({
    ...translated,
    parts: translated.parts.map((part) => ({ ...part, x: part.x + 100 })),
  });
  const changed = updatePCBFromSchematic(disconnected, owned, new Map());
  assert.equal(changed.changed, true);
  assert.ok(changed.board.footprints[0].pads.every((pad) => pad.netId === null));
  assert.equal(changed.board.zones[0].filledPolygons, undefined);
  assert.ok(owned.zones[0].filledPolygons);
});

test('equal independent board wrappers stay no-ops and duplicate net records are not hidden by identity reuse', () => {
  const { circuit } = fixture();
  const original = updatePCBFromSchematic(circuit, undefined, sources).board;
  for (const board of [structuredClone(original), ownProjectData(structuredClone(original))]) {
    const before = JSON.stringify(board);
    const repeated = updatePCBFromSchematic(circuit, board, new Map());
    assert.equal(repeated.changed, false);
    assert.equal(repeated.board, board);
    assert.equal(JSON.stringify(repeated.board), before);
  }
  for (const owned of [false, true]) {
    const copy = structuredClone(original);
    copy.nets.push({ ...copy.nets[0] });
    const board = owned ? ownProjectData(copy) : copy;
    const before = JSON.stringify(board);
    const result = updatePCBFromSchematic(circuit, board, new Map());
    assert.equal(result.changed, true);
    assert.notEqual(JSON.stringify(result.board), before);
    assert.equal(JSON.stringify(board), before);
    assert.equal(updatePCBFromSchematic(circuit, result.board, new Map()).changed, false);
  }
});

// Independent all-anchor/all-wire oracle for unnamed resistor networks. Keep
// the original geometry predicate here so spatial filtering has a differential
// check across bucket boundaries, nonorthogonal and very long segments.
function bruteResistorNets(circuit: Circuit) {
  const points: Point[] = [],
    parents: number[] = [];
  const add = (point: Point) => {
    const index = points.push(point) - 1;
    parents.push(index);
    return index;
  };
  const root = (index: number): number =>
    parents[index] === index ? index : (parents[index] = root(parents[index]));
  const join = (a: number, b: number) => (parents[root(a)] = root(b));
  const wires = circuit.wires.map((wire) => {
    const a = add(wire.a);
    join(a, add(wire.b));
    return a;
  });
  const pins = circuit.parts.flatMap((part) =>
    pinPositions(part, circuit.libraries[part.libId]).map((point, index) => ({
      key: pcbPinKey(part.ref, String(index + 1)),
      ref: part.ref,
      number: String(index + 1),
      index: add(point),
    })),
  );
  circuit.junctions.forEach(add);
  const coordinates = new Map<string, number>();
  points.forEach((point, index) => {
    const key = `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
    const previous = coordinates.get(key);
    if (previous !== undefined) join(index, previous);
    coordinates.set(key, index);
    circuit.wires.forEach((wire, j) => {
      const { a, b } = wire;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (
        length > 0 &&
        Math.abs((point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x)) / length <
          0.00005 &&
        point.x >= Math.min(a.x, b.x) - 0.00005 &&
        point.x <= Math.max(a.x, b.x) + 0.00005 &&
        point.y >= Math.min(a.y, b.y) - 0.00005 &&
        point.y <= Math.max(a.y, b.y) + 0.00005
      )
        join(index, wires[j]);
    });
  });
  const groups = new Map<number, typeof pins>();
  pins.forEach((pin) => {
    const group = root(pin.index);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(pin);
  });
  const connected = new Set(wires.map(root));
  return [...groups.entries()]
    .filter(([group, members]) => members.length > 1 || connected.has(group))
    .map(([, members]) => {
      const first = [...members].sort((a, b) => a.key.localeCompare(b.key))[0];
      return {
        name: `Net-(${first.ref}-Pad${first.number})`,
        pins: members.map((pin) => pin.key).sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

test('spatial PCB connectivity preserves exhaustive geometry and owned cache results remain independent', () => {
  let seed = 98249;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;
  for (let sample = 0; sample < 12; sample++) {
    const circuit = emptyCircuit();
    for (let index = 0; index < 20; index++) {
      const part = createPart(circuit, 'R', (index % 5) * 10 - 20, Math.floor(index / 5) * 10 - 20);
      part.rotation = (index % 4) * 90;
      circuit.parts.push(part);
    }
    const pins = circuit.parts.flatMap((part) => pinPositions(part, circuit.libraries[part.libId]));
    const pick = () => pins[Math.floor(random() * pins.length)];
    circuit.wires = Array.from({ length: 60 }, () => ({ id: uid(), a: pick(), b: pick() }));
    circuit.wires.push(
      { id: uid(), a: { x: -10000, y: 0 }, b: { x: 10000, y: 0 } },
      { id: uid(), a: { x: -10000, y: -10000 }, b: { x: 10000, y: 10000 } },
      { id: uid(), a: { x: 9.99995, y: -10 }, b: { x: 10.00005, y: 10 } },
      { id: uid(), a: { x: -10.00005, y: -10 }, b: { x: -9.99995, y: 10 } },
    );
    circuit.junctions = [{ id: uid(), x: 0, y: 0 }];
    const expected = bruteResistorNets(circuit);
    assert.deepEqual(schematicPCBNets(circuit), expected, `sample ${sample}`);
    const owned = ownProjectData(circuit);
    const actual = schematicPCBNets(owned);
    actual[0].pins.push('poison');
    actual.reverse();
    assert.deepEqual(schematicPCBNets(owned), expected);
    Object.freeze(circuit);
    circuit.wires.length = 0;
    assert.deepEqual(schematicPCBNets(circuit), bruteResistorNets(circuit));
  }
  const bounded = emptyCircuit();
  bounded.wires = Array.from({ length: 1600 }, () => ({
    id: uid(),
    a: { x: 0, y: 0 },
    b: { x: 1, y: 0 },
  }));
  assert.throws(() => schematicPCBNets(bounded), /connectivity update limit/);
});
test('virtual components create no packages or missing-package warnings; clearing an assignment removes only its package', () => {
  const { circuit, p } = fixture();
  const board = updatePCBFromSchematic(circuit, undefined, sources).board;
  const track = {
    id: uid(),
    start: { x: 1, y: 2 },
    end: { x: 3, y: 4 },
    netId: board.nets[0].id,
    width: 0.25,
    layer: 'F.Cu' as const,
  };
  board.tracks.push(track);
  p.fields!.Footprint = '';
  const result = updatePCBFromSchematic(circuit, board, new Map());
  assert.equal(result.board.footprints.length, 0);
  assert.deepEqual(result.board.tracks, board.tracks);
  assert.equal(board.footprints.length, 1, 'The original project remains undoable.');
  assert.ok(!result.warnings.some((warning) => warning.includes('no assigned footprint')));
  const empty = new PCBProjectSync().prepare(createProject(circuit));
  assert.equal(empty?.project.pcb, null);
});
test('renaming a net preserves footprint pose, pad IDs, copper and zone geometry', () => {
  const { circuit } = fixture();
  const board = updatePCBFromSchematic(circuit, undefined, sources).board;
  board.footprints[0] = {
    ...flipPCBFootprint(board.footprints[0]),
    x: 33.02,
    y: 27.94,
    rotation: 90,
  };
  const netId = board.nets.find((n) => n.name === 'IN')!.id;
  board.tracks.push({
    id: uid(),
    start: { x: 1, y: 2 },
    end: { x: 3, y: 4 },
    netId,
    width: 0.25,
    layer: 'B.Cu',
  });
  board.vias.push({ id: uid(), x: 3, y: 4, netId, diameter: 0.8, drill: 0.4 });
  board.zones.push({
    id: uid(),
    netId,
    layer: 'F.Cu',
    outline: [
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 9 },
    ],
    clearance: 0.2,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  });
  circuit.labels[0].text = 'VIN';
  const result = updatePCBFromSchematic(circuit, board, sources);
  assert.equal(result.board.nets.find((n) => n.name === 'VIN')!.id, netId);
  assert.deepEqual(result.board.footprints, board.footprints);
  assert.deepEqual(result.board.tracks, board.tracks);
  assert.deepEqual(result.board.vias, board.vias);
  assert.deepEqual(result.board.zones, board.zones);
});
test('split nets keep existing copper isolated from new pad nets and report it; merging relabels safely', () => {
  const { circuit } = fixture();
  circuit.labels[1].text = 'IN';
  const board = updatePCBFromSchematic(circuit, undefined, sources).board;
  const netId = board.nets[0].id;
  board.tracks.push({
    id: uid(),
    start: { x: 1, y: 2 },
    end: { x: 3, y: 4 },
    netId,
    width: 0.25,
    layer: 'F.Cu',
  });
  circuit.labels[1].text = 'OUT';
  const split = updatePCBFromSchematic(circuit, board, sources);
  assert.deepEqual(split.board.tracks, board.tracks);
  assert.ok(split.board.footprints[0].pads.every((p) => p.netId !== netId));
  assert.ok(split.warnings.some((w) => w.includes('retained copper')));
  assert.equal(new Set(split.board.nets.map((n) => n.name)).size, split.board.nets.length);
  assert.equal(updatePCBFromSchematic(circuit, split.board, sources).changed, false);
  const firstPadNet = split.board.footprints[0].pads[0].netId!;
  const secondPadNet = split.board.footprints[0].pads[1].netId!;
  split.board.tracks.push({ ...board.tracks[0], id: uid(), netId: secondPadNet });
  circuit.labels[1].text = 'IN';
  const merged = updatePCBFromSchematic(circuit, split.board, sources);
  assert.equal(merged.board.tracks[1].netId, firstPadNet);
  assert.equal(merged.board.tracks[1].id, split.board.tracks[1].id);
});
test('crossings require explicit anchors; T endpoints and equal labels join; no-connect conflicts fail', () => {
  const { circuit, pins } = fixture();
  const a = pins[0],
    b = pins[1];
  circuit.labels = [];
  circuit.wires = [
    { id: uid(), a, b: { x: a.x + 20, y: a.y } },
    { id: uid(), a: b, b: { x: a.x + 10, y: b.y } },
    { id: uid(), a: { x: a.x + 10, y: b.y }, b: { x: a.x + 10, y: a.y - 10 } },
  ];
  assert.equal(schematicPCBNets(circuit).length, 2);
  circuit.junctions.push({ id: uid(), x: a.x + 10, y: a.y });
  assert.equal(schematicPCBNets(circuit).length, 1);
  circuit.noConnects = [{ id: uid(), ...a }];
  assert.throws(() => schematicPCBNets(circuit), /no-connect/);
  circuit.wires = [];
  circuit.junctions = [];
  assert.deepEqual(schematicPCBNets(circuit), []);
  circuit.labels = [{ id: uid(), ...b, text: 'GND' }];
  assert.equal(schematicPCBNets(circuit)[0].name, 'GND');
});
test('changing a package preserves footprint identity, side, rotation, position and surviving pad identities', () => {
  const { circuit, p } = fixture();
  const board = updatePCBFromSchematic(circuit, undefined, sources).board;
  board.footprints[0] = {
    ...flipPCBFootprint(board.footprints[0]),
    x: 25.4,
    y: 50.8,
    rotation: 270,
  };
  const old = board.footprints[0];
  const nextDetail = structuredClone(detail);
  nextDetail.id = 'Test:Other';
  nextDetail.footprint[1] = 'Other';
  const at = child(children(nextDetail.footprint, 'pad')[1], 'at')!;
  at[1] = '5.08';
  p.fields!.Footprint = nextDetail.id;
  const result = updatePCBFromSchematic(circuit, board, new Map([[nextDetail.id, nextDetail]]));
  const f = result.board.footprints[0];
  assert.deepEqual(
    [f.id, f.x, f.y, f.rotation, f.side],
    [old.id, old.x, old.y, old.rotation, old.side],
  );
  assert.deepEqual(
    f.pads.map((p) => p.id),
    old.pads.map((p) => p.id),
  );
  assert.equal(f.pads[1].x, 5.08);
  assert.equal(result.replaced, 1);
  assert.ok(result.warnings.some((w) => w.includes('alignment')));
});
test('unit pin numbers, hidden power pins and explicit power symbols determine physical connectivity', () => {
  const { circuit, p } = fixture();
  const lib = circuit.libraries[p.libId];
  const pin = children(
    children(lib, 'symbol').find((s) => children(s, 'pin').length)!,
    'pin',
  )[0];
  pin[1] = 'power_in';
  pin.push('hide');
  child(pin, 'name')![1] = 'VCC';
  circuit.labels[0].text = 'VCC';
  const nets = schematicPCBNets(circuit);
  assert.ok(nets.find((n) => n.name === 'VCC')!.pins.includes(pcbPinKey(p.ref, '1')));
  circuit.labels[0].text = 'CONFLICT';
  assert.throws(() => schematicPCBNets(circuit), /conflicting names/);
});
test('automatic project materialization is bounded, cancellable, and uses stable resolved snapshots', async () => {
  const { circuit } = fixture();
  const project = createProject(circuit),
    sync = new PCBProjectSync();
  assert.equal(sync.prepare(project), null);
  let calls = 0;
  const resolved = await sync.resolve(
    project,
    async () => {
      calls++;
      return detail;
    },
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.ok(resolved.project.pcb);
  assert.equal(project.pcb, null);
  assert.equal(sync.prepare(structuredClone(project))?.project, resolved.project);
  assert.equal(sync.prepare(resolved.project)?.project, resolved.project);
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(
    new PCBProjectSync().resolve(project, async () => detail, cancel.signal),
    /abort/i,
  );
  assert.throws(() => updatePCBFromSchematic(circuit, undefined, new Map()), /could not load/);
});

test('opened embedded boards stay unchanged until schematic edits and retain source package aliases', async () => {
  const { circuit, p } = fixture();
  const board = updatePCBFromSchematic(circuit, undefined, sources).board;
  board.footprints[0].libraryId = 'OriginalEmbeddedPackage';
  p.fields!.Footprint = 'SourceLibrary:OriginalPackage';
  const project = { ...createProject(circuit), pcb: board };
  const before = serializeProject(project);
  const sync = new PCBProjectSync(project);
  const requested: string[] = [];
  const load = async (id: string) => {
    requested.push(id);
    const loaded = { ...structuredClone(detail), id };
    loaded.footprint[1] = id.split(':').at(-1)!;
    return loaded;
  };
  const resolve = (next: typeof project) => sync.resolve(next, load, new AbortController().signal);
  assert.equal((await resolve(project)).project, project);
  assert.equal(serializeProject(project), before);
  const boardEdit = structuredClone(project);
  boardEdit.pcb.footprints[0].x += 1.27;
  assert.equal(
    (await resolve(boardEdit)).project,
    boardEdit,
    'Board-only edits remain authoritative.',
  );
  const changed = structuredClone(project);
  changed.schematic.labels[0].text = 'VIN';
  const synced = await resolve(changed);
  assert.ok(synced.project.pcb!.nets.some((net) => net.name === 'VIN'));
  assert.deepEqual(synced.project.pcb!.footprints, board.footprints);
  assert.deepEqual(requested, [], 'Source package aliases reuse their loaded embedded geometry.');
  const replacement = structuredClone(changed);
  replacement.schematic.parts[0].fields!.Footprint = 'Test:Replacement';
  const replaced = await resolve(replacement);
  assert.equal(replaced.project.pcb!.footprints[0].libraryId, 'Test:Replacement');
  assert.deepEqual(requested, ['Test:Replacement']);
  const reassigned = structuredClone(replaced.project);
  reassigned.schematic.parts[0].fields!.Footprint = 'SourceLibrary:OriginalPackage';
  await sync.resolve(reassigned, load, new AbortController().signal);
  assert.deepEqual(
    requested,
    ['Test:Replacement', 'SourceLibrary:OriginalPackage'],
    'An alias cannot hide a later real package change.',
  );
  assert.equal(serializeProject(project), before);
});

test('multiple units share one footprint and map all physical pin numbers', () => {
  const circuit = emptyCircuit();
  const library = parseSExpr(`(symbol "Test:Split" (symbol "Split_1_1"
    (pin passive line (at 0 0 0) (length 1) (name "A") (number "1")))
    (symbol "Split_2_1" (pin passive line (at 0 0 0) (length 1) (name "B") (number "2"))))`);
  circuit.libraries['Test:Split'] = library;
  circuit.parts = [1, 2].map((unit) => ({
    id: uid(),
    libId: 'Test:Split',
    ref: 'U1',
    value: 'Split',
    x: unit * 10,
    y: 10,
    rotation: 0,
    unit,
    fields: { Footprint: detail.id },
  }));
  circuit.labels = circuit.parts.map((part, i) => ({
    id: uid(),
    x: part.x,
    y: part.y,
    text: i ? 'OUT' : 'IN',
  }));
  const result = updatePCBFromSchematic(circuit, undefined, sources);
  assert.equal(result.board.footprints.length, 1);
  assert.deepEqual(
    result.board.footprints[0].pads.map(
      (p) => result.board.nets.find((n) => n.id === p.netId)!.name,
    ),
    ['IN', 'OUT'],
  );
  circuit.parts[1].fields!.Footprint = 'Test:Other';
  assert.throws(() => pcbUpdateFootprintIds(circuit), /different footprint assignments/);
});

test('automatic materialization preserves additional schematics, extensions and the complete original on failure', async () => {
  const { circuit } = fixture();
  const project = createProject(circuit);
  project.additionalSchematics = [emptyCircuit()];
  project.additionalSchematics[0].title = 'Independent';
  project.extensions = { 'org.openpe.test': { retained: [1, 2, 3] } };
  const before = serializeProject(project);
  const sync = new PCBProjectSync();
  await assert.rejects(
    sync.resolve(
      project,
      async () => {
        throw new Error('Unavailable');
      },
      new AbortController().signal,
    ),
    /Unavailable/,
  );
  assert.equal(serializeProject(project), before);
  const result = await sync.resolve(project, async () => detail, new AbortController().signal);
  assert.deepEqual(result.project.additionalSchematics, project.additionalSchematics);
  assert.deepEqual(result.project.extensions, project.extensions);
  assert.equal(serializeProject(project), before);
});
