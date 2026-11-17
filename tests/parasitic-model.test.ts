import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  serializeCircuit,
  uid,
  type Part,
} from '../lib/circuit';
import { ownProject } from '../lib/immutable-project';
import { partFields } from '../lib/library';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { Footprint, PCB } from '../lib/pcb';
import { createProject } from '../lib/project';
import { parasiticPhysicalModels } from '../lib/parasitic-model';
import { moveSelection, saveLabel, transformSelection } from '../lib/schematic-edit';
import { child, children, val } from '../lib/sexpr';

const prefix = 'OpenPE.Parasitics.';
function fixture(withInductor = true) {
  let circuit = emptyCircuit();
  const left = createPart(circuit, 'C', -20.32, 0);
  circuit.parts.push(left);
  const right = createPart(circuit, 'C', 80.01, 0);
  circuit.parts.push(right);
  const resistor = createPart(circuit, 'R', 22.86, 12.7);
  resistor.rotation = 90;
  circuit.parts.push(resistor);
  const inductor = withInductor ? createPart(circuit, 'L', 43.18, 12.7) : null;
  if (inductor) {
    inductor.rotation = 90;
    circuit.parts.push(inductor);
  }
  const metadata = Object.fromEntries(
    Object.entries({
      Connection: 'series',
      GroupId: uid(),
      BoardId: uid(),
      StartId: uid(),
      EndId: uid(),
      Start: 'C1.1',
      End: 'C2.1',
      StartLabel: 'LP_C1.1',
      EndLabel: 'LP_C2.1',
    }).map(([key, value]) => [prefix + key, value]),
  );
  resistor.fields = { Footprint: '', ...metadata, [prefix + 'Role']: 'resistor' };
  if (inductor) inductor.fields = { Footprint: '', ...metadata, [prefix + 'Role']: 'inductor' };
  const pin = (part: typeof resistor, index: number) =>
    pinPositions(part, circuit.libraries[part.libId])[index];
  const start = pin(resistor, 0),
    end = pin(inductor ?? resistor, 1);
  if (inductor) circuit.wires.push({ id: uid(), a: pin(resistor, 1), b: pin(inductor, 0) });
  for (const [name, position] of [
    ['LP_C1.1', start],
    ['LP_C1.1', pin(left, 0)],
    ['LP_C2.1', end],
    ['LP_C2.1', pin(right, 0)],
  ] as const)
    circuit = saveLabel(circuit, { text: name, position }).circuit;
  circuit = parseCircuit(serializeCircuit(circuit));
  for (const part of circuit.parts.filter((part) =>
    [resistor.id, inductor?.id].includes(part.id),
  )) {
    part.fields = partFields(part);
    for (const name of ['on_board', 'in_bom']) child(part.raw!, name)![1] = 'no';
  }
  return {
    circuit,
    leftId: left.id,
    rightId: right.id,
    resistorId: resistor.id,
    inductorId: inductor?.id,
    start,
    end,
  };
}

test('explicit series native groups preserve source data and survive move, rotation and reopen', () => {
  for (const withInductor of [false, true]) {
    const { circuit } = fixture(withInductor);
    const source = serializeCircuit(circuit);
    const model = parasiticPhysicalModels(circuit)[0];
    assert.deepEqual(
      model.parts.map((part) => part.libId),
      withInductor ? ['Device:R', 'Device:L'] : ['Device:R'],
    );
    assert.deepEqual([model.startLabel, model.endLabel], ['LP_C1.1', 'LP_C2.1']);
    assert.equal(serializeCircuit(circuit), source);
    const ids = [...circuit.parts, ...circuit.wires, ...circuit.labels, ...circuit.junctions].map(
      (part) => part.id,
    );
    const moved = moveSelection(transformSelection(circuit, ids, 'rotate'), ids, {
      x: 15.24,
      y: -8.89,
    });
    assert.equal(parasiticPhysicalModels(moved).length, 1);
    assert.equal(parasiticPhysicalModels(parseCircuit(serializeCircuit(moved))).length, 1);
  }
});

test('ordinary virtual passives and provenance alone never create a physical short', () => {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 0, 0);
  part.fields = {
    [prefix + 'BoardId']: uid(),
    [prefix + 'StartId']: uid(),
    [prefix + 'EndId']: uid(),
  };
  circuit.parts.push(part);
  assert.deepEqual(parasiticPhysicalModels(circuit), []);
  part.fields[prefix + 'Role'] = 'resistor';
  assert.throws(() => parasiticPhysicalModels(circuit), /Connection/);
});

test('declared endpoint aliases and symmetric terminal reversal retain the same series topology', () => {
  const { circuit, start, resistorId, inductorId } = fixture();
  const cut = { x: start.x - 1.27, y: start.y };
  circuit.wires.push({ id: uid(), a: start, b: cut });
  const linked = saveLabel(circuit, { text: 'LP_C1.1', position: cut }).circuit;
  assert.equal(linked.labels.filter((label) => label.text === 'LP_C1.1').length, 3);
  for (const id of [resistorId, inductorId]) {
    const part = linked.parts.find((part) => part.id === id)!;
    part.rotation = (part.rotation + 180) % 360;
  }
  assert.equal(parasiticPhysicalModels(linked).length, 1);
});

test('duplicate primitives, missing members and reused endpoint identities cannot grant collapse', () => {
  const duplicate = fixture();
  const part = structuredClone(
    duplicate.circuit.parts.find((part) => part.id === duplicate.resistorId)!,
  );
  part.id = uid();
  part.ref = 'R99';
  child(part.raw!, 'uuid')![1] = JSON.stringify(part.id);
  duplicate.circuit.parts.push(part);
  assert.throws(() => parasiticPhysicalModels(duplicate.circuit), /one resistor/);
  const missing = fixture();
  missing.circuit.parts = missing.circuit.parts.filter((part) => part.id !== missing.inductorId);
  assert.throws(() => parasiticPhysicalModels(missing.circuit), /both declared/);
  const labels = fixture();
  for (const model of labels.circuit.parts.filter((part) =>
    [labels.resistorId, labels.inductorId].includes(part.id),
  ))
    model.fields![prefix + 'EndLabel'] = model.fields![prefix + 'StartLabel'];
  assert.throws(() => parasiticPhysicalModels(labels.circuit), /distinct LP/);
});

test('explicit groups reject malformed identity, membership, native flags and active model overrides', () => {
  const mutations: [string, (part: Part & { fields: Record<string, string> }) => void, RegExp][] = [
    [
      'empty role',
      (part) => {
        part.fields[prefix + 'Role'] = '';
      },
      /Role/,
    ],
    [
      'group identity',
      (part) => {
        part.fields[prefix + 'GroupId'] = 'invalid';
      },
      /GroupId/,
    ],
    [
      'endpoint identity',
      (part) => {
        part.fields[prefix + 'EndId'] = part.fields[prefix + 'StartId'];
      },
      /distinct PCB/,
    ],
    [
      'endpoint disagreement',
      (part) => {
        part.fields[prefix + 'End'] = 'Other.2';
      },
      /disagrees/,
    ],
    [
      'package',
      (part) => {
        part.fields.Footprint = 'Test:Package';
      },
      /Footprint/,
    ],
    [
      'board inclusion',
      (part) => {
        child(part.raw!, 'on_board')![1] = 'yes';
      },
      /on_board/,
    ],
    [
      'BOM inclusion',
      (part) => {
        child(part.raw!, 'in_bom')![1] = 'yes';
      },
      /in_bom/,
    ],
    [
      'external model',
      (part) => {
        Object.assign(part.fields, {
          'OpenPE.ModelSource': 'external',
          'Sim.Library': 'model.lib',
          'Sim.Name': 'part',
        });
      },
      /basic R/,
    ],
    [
      'other primitive',
      (part) => {
        part.fields['OpenPE.PassiveModel'] = 'C';
      },
      /basic R/,
    ],
  ];
  for (const [name, update, expected] of mutations) {
    const { circuit, resistorId } = fixture();
    const resistor = circuit.parts.find((part) => part.id === resistorId)!;
    assert.ok(resistor.fields);
    update(resistor as typeof resistor & { fields: Record<string, string> });
    assert.throws(() => parasiticPhysicalModels(circuit), expected, name);
  }
  const { circuit, resistorId } = fixture();
  const part = circuit.parts.find((part) => part.id === resistorId)!;
  part.excludeFromSimulation = true;
  Object.assign(part.fields!, {
    'OpenPE.ModelSource': 'basic',
    'OpenPE.PassiveModel': 'R',
    'Sim.Library': 'inactive.lib',
    'Sim.Name': 'inactive',
  });
  assert.equal(
    parasiticPhysicalModels(circuit).length,
    1,
    'Participation and inactive binding do not change physical interconnect.',
  );
});

test('groups require canonical passive pins while preserving compatible custom body drawings', () => {
  const { circuit } = fixture();
  const library = circuit.libraries['Device:R'];
  const group = children(library, 'symbol').find((unit) => children(unit, 'pin').length)!;
  group.push([
    'text',
    '"Body annotation"',
    ['at', '20', '0', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']]],
  ]);
  assert.equal(parasiticPhysicalModels(circuit).length, 1);
  children(group, 'pin')[0][1] = 'input';
  assert.throws(() => parasiticPhysicalModels(circuit), /canonical two-terminal/);
});

test('ideal bypasses, missing outer links and branched intermediate nodes reject', () => {
  const bypass = fixture();
  bypass.circuit.wires.push({ id: uid(), a: bypass.start, b: bypass.end });
  assert.throws(() => parasiticPhysicalModels(bypass.circuit), /ideal bypass/);
  const isolated = fixture();
  isolated.circuit.parts = isolated.circuit.parts.filter(
    (part) => ![isolated.leftId, isolated.rightId].includes(part.id),
  );
  assert.throws(() => parasiticPhysicalModels(isolated.circuit), /existing component pins/);
  const branched = fixture();
  const middle = branched.circuit.wires[0].a;
  const extra = createPart(branched.circuit, 'C', middle.x, middle.y);
  const firstPin = pinPositions(extra, branched.circuit.libraries[extra.libId])[0];
  extra.x += middle.x - firstPin.x;
  extra.y += middle.y - firstPin.y;
  branched.circuit.parts.push(extra);
  assert.throws(() => parasiticPhysicalModels(branched.circuit), /intermediate/);
  const named = fixture();
  named.circuit = saveLabel(named.circuit, {
    text: 'Unexpected tap',
    position: named.circuit.wires[0].a,
  }).circuit;
  assert.throws(() => parasiticPhysicalModels(named.circuit), /intermediate/);
});

test('owned caches return independent containers and caller freezing cannot cache malformed edits', () => {
  const { circuit } = fixture();
  const owned = ownProject(createProject(circuit)).schematic;
  const first = parasiticPhysicalModels(owned);
  first[0].parts.length = 0;
  first.length = 0;
  assert.equal(parasiticPhysicalModels(owned)[0].parts.length, 2);
  Object.freeze(circuit);
  assert.equal(parasiticPhysicalModels(circuit).length, 1);
  const part = circuit.parts.find((part) => val(child(part.raw ?? [], 'lib_id')) === 'Device:R')!;
  part.fields![prefix + 'Connection'] = 'unsupported';
  assert.throws(() => parasiticPhysicalModels(circuit), /Connection/);
});

function boardFixture() {
  const design = fixture();
  const model = design.circuit.parts.find((part) => part.id === design.resistorId)!;
  const fields = partFields(model);
  const board = createEmptyPCB();
  board.id = fields[prefix + 'BoardId'];
  const netId = uid();
  board.nets = [{ id: netId, name: 'Physical conductor' }];
  const packageFor = (partId: string, padId: string): Footprint => ({
    id: uid(),
    symbolId: partId,
    libraryId: 'Test:Package',
    x: 0,
    y: 0,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [
      {
        id: padId,
        number: '1',
        netId,
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'rect',
        size: { x: 1, y: 1 },
        layers: ['F.Cu'],
      },
    ],
  });
  board.footprints = [
    packageFor(design.leftId, fields[prefix + 'StartId']),
    packageFor(design.rightId, fields[prefix + 'EndId']),
  ];
  return { ...design, board };
}

test('current PCB association is revalidated after successful structural cache reuse', () => {
  const { circuit, board } = boardFixture();
  const owned = ownProject(createProject(circuit)).schematic;
  assert.equal(parasiticPhysicalModels(owned).length, 1);
  assert.equal(parasiticPhysicalModels(owned, board).length, 1);
  const moved = structuredClone(board);
  moved.footprints[0].x += 20;
  assert.equal(parasiticPhysicalModels(owned, moved).length, 1);
  const wrongBoard = structuredClone(board);
  wrongBoard.id = uid();
  assert.throws(() => parasiticPhysicalModels(owned, wrongBoard), /originating PCB/);
  const wrongPin = structuredClone(board);
  wrongPin.footprints[1].pads[0].number = '2';
  assert.throws(() => parasiticPhysicalModels(owned, wrongPin), /declared LP outer net/);
  assert.equal(
    parasiticPhysicalModels(owned, board).length,
    1,
    'A failed board check cannot poison later valid calls.',
  );
});

test('removed, unlinked, ambiguous and reassigned pad endpoints cannot retain PCB collapse authority', () => {
  const mutations: [(board: PCB) => void, RegExp][] = [
    [
      (board) => {
        const duplicate = structuredClone(board.footprints[0].pads[0]);
        duplicate.id = uid();
        board.footprints[0].pads.push(duplicate);
      },
      /unambiguous pad number/,
    ],
    [
      (board) => {
        board.footprints[0].pads.length = 0;
      },
      /exact original schematic pad/,
    ],
    [
      (board) => {
        board.footprints[0].symbolId = null;
      },
      /exact original schematic pad/,
    ],
    [
      (board) => {
        board.footprints[0].pads[0].number = 'unknown';
      },
      /unambiguous/,
    ],
    [
      (board) => {
        board.footprints[1].pads[0].netId = uid();
      },
      /assigned net/,
    ],
    [
      (board) => {
        board.footprints[1].symbolId = board.footprints[0].symbolId;
      },
      /declared LP outer net/,
    ],
    [
      (board) => {
        const duplicate = structuredClone(board.footprints[0]);
        duplicate.id = uid();
        board.footprints.push(duplicate);
      },
      /ambiguous/,
    ],
  ];
  for (const [update, expected] of mutations) {
    const { circuit, board } = boardFixture();
    update(board);
    assert.throws(() => parasiticPhysicalModels(circuit, board), expected);
  }
  const { circuit, board } = boardFixture();
  const other = fixture();
  const original = partFields(circuit.parts.find((part) => part.libId === 'Device:R')!);
  for (const part of other.circuit.parts.filter((part) =>
    ['Device:R', 'Device:L'].includes(part.libId),
  ))
    for (const key of ['BoardId', 'StartId', 'EndId'])
      part.fields![prefix + key] = original[prefix + key];
  assert.throws(
    () => parasiticPhysicalModels(other.circuit, board),
    /exact original schematic pad/,
    'Equal component references in another circuit do not establish ownership.',
  );
});
