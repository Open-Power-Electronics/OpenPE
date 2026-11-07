import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPart,
  emptyCircuit,
  pinPositions,
  uid,
  type Circuit,
  type Part,
} from '../lib/circuit';
import { parseSExpr } from '../lib/sexpr';
import { schematicDrafting } from '../lib/schematic-drafting';
import { projectNetGroups, projectPhysicalNetGroups } from '../lib/project-net-groups';
import { commitWireRoute } from '../lib/wiring';

function symbol(type = 'passive') {
  return parseSExpr(`(symbol "Test:Block"
    (property "Reference" "R" (at 0 5 0))
    (property "Value" "Block" (at 0 -5 0))
    (symbol "Block_0_1" (rectangle (start -2 -3) (end 4 1)))
    (symbol "Block_1_1"
      (pin ${type} line (at -5.08 1.27 0) (length 2.54) (name "A") (number "1"))
      (pin passive line (at 5.08 1.27 180) (length 2.54) (name "B") (number "2"))
      (pin passive line (at 0 0 0) (length 1.27) hide (name "Hidden") (number "3"))))`);
}
function part(ref: string, x: number, y: number): Part {
  return { id: uid(), libId: 'Test:Block', ref, value: '10k', x, y, rotation: 0, unit: 1 };
}
function labelledStubs() {
  const circuit = emptyCircuit();
  circuit.libraries['Test:Block'] = symbol();
  circuit.parts = [part('R1', 10.16, 20.32), part('R2', 50.8, 20.32)];
  const anchors = circuit.parts.map((p) => pinPositions(p, circuit.libraries[p.libId])[0]);
  for (const anchor of anchors) {
    const end = { x: anchor.x - 2.54, y: anchor.y };
    circuit.wires.push({ id: uid(), a: anchor, b: end });
    circuit.labels.push({ id: uid(), ...end, text: 'FEEDBACK' });
  }
  return { circuit, anchors };
}

test('drafting identifies label-mediated pin islands without changing valid connectivity', () => {
  const { circuit } = labelledStubs();
  const before = JSON.stringify(circuit);
  const electrical = projectNetGroups(circuit);
  const report = schematicDrafting(circuit);
  assert.equal(report.advisory, true);
  assert.equal(report.counts.labelLinkedNets, 1);
  assert.equal(report.counts.singlePinStubIslands, 2);
  assert.equal(report.labelLinks.total, 1);
  const link = report.labelLinks.items[0];
  assert.equal(link.name, 'FEEDBACK');
  assert.equal(link.physicalIslandCount, 2);
  assert.equal(link.componentPinCount, 2);
  assert.equal(link.singlePinStubIslandCount, 2);
  assert.deepEqual(
    link.islands.items.map((island) => island.pins.items.map((pin) => [pin.reference, pin.number])),
    [[['R1', '1']], [['R2', '1']]],
  );
  assert.ok(
    link.islands.items.every((island) => island.labelIds.total === 1 && island.wireIds.total === 1),
  );
  assert.deepEqual(projectNetGroups(circuit), electrical);
  assert.equal(JSON.stringify(circuit), before);
  assert.ok(report.notes.some((note) => /not ERC/.test(note)));
});

test('drawing the same pin connection continuously removes the label-island candidate', () => {
  const { circuit, anchors } = labelledStubs();
  const connected = commitWireRoute(circuit, [
    anchors[0],
    { x: anchors[0].x, y: 10.16 },
    { x: anchors[1].x, y: 10.16 },
    anchors[1],
  ]);
  // Keeping a repeated name on an already wired rail is not a drafting failure.
  assert.equal(connected.labels.length, 2);
  const report = schematicDrafting(connected);
  assert.equal(report.counts.labelLinkedNets, 0);
  assert.equal(report.counts.singlePinStubIslands, 0);
  assert.equal(report.labels.total, 2);
  const keys = (doc: Circuit) =>
    projectNetGroups(doc)
      .map((group) => group.pins.slice().sort())
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(keys(connected), keys(circuit));
});

test('actual power-symbol names do not become label-island candidates', () => {
  const { circuit } = labelledStubs();
  // The actual marker identity, not a guessed list of rail spellings, identifies
  // this named supply. The query does not prohibit ordinary remote power rails.
  circuit.labels.forEach((label) => {
    label.text = 'GND';
  });
  const ground = createPart(circuit, 'GND', circuit.labels[0].x, circuit.labels[0].y);
  circuit.parts.push(ground);
  const report = schematicDrafting(circuit);
  assert.equal(report.labelLinks.total, 0);
  assert.equal(report.counts.excludedPowerLabelLinks, 1);
});

test('ordinary rail labels remain observable when their pins are power inputs', () => {
  const power = labelledStubs().circuit;
  power.libraries['Test:Block'] = symbol('power_in');
  power.labels.forEach((label) => {
    label.text = 'VIN';
  });
  const report = schematicDrafting(power);
  assert.equal(report.labelLinks.total, 1);
  assert.equal(report.labelLinks.items[0].name, 'VIN');
  assert.equal(report.labelLinks.items[0].containsPowerPins, true);
  assert.equal(report.counts.excludedPowerLabelLinks, 0);
});

test('ordinary aliases retain power evidence from a marker-only physical island', () => {
  const { circuit } = labelledStubs();
  circuit.labels.forEach((label) => {
    label.text = 'RETURN';
  });
  const ground = createPart(circuit, 'GND', 101.6, 50.8);
  circuit.parts.push(ground);
  const anchor = pinPositions(ground, circuit.libraries[ground.libId])[0];
  circuit.labels.push({ id: uid(), ...anchor, text: 'RETURN' });

  const report = schematicDrafting(circuit);
  assert.equal(report.labelLinks.total, 1, 'An ordinary alias remains observable.');
  const link = report.labelLinks.items[0];
  assert.equal(link.name, 'RETURN');
  assert.equal(link.containsPowerPins, true, 'Keep the marker-only island power evidence.');
  assert.equal(
    link.physicalIslandCount,
    2,
    'Reported pin islands still omit the marker-only island.',
  );
  assert.equal(link.componentPinCount, 2);
  assert.equal(report.counts.excludedPowerLabelLinks, 0);
});

test('unmarked orthogonal crossings remain separate while a deliberate junction joins them', () => {
  const circuit = emptyCircuit();
  circuit.wires = [
    { id: uid(), a: { x: 0, y: 5.08 }, b: { x: 10.16, y: 5.08 } },
    { id: uid(), a: { x: 5.08, y: 0 }, b: { x: 5.08, y: 10.16 } },
  ];
  assert.equal(projectPhysicalNetGroups(circuit).length, 2);
  assert.equal(schematicDrafting(circuit).counts.physicalIslands, 2);
  circuit.junctions.push({ id: uid(), x: 5.08, y: 5.08 });
  assert.equal(projectPhysicalNetGroups(circuit).length, 1);
  assert.equal(schematicDrafting(circuit).counts.physicalIslands, 1);
});

test('pin and body observations preserve transformed native off-grid anchors and hidden pins', () => {
  const circuit = emptyCircuit();
  circuit.libraries['Test:Block'] = symbol();
  circuit.parts = [{ ...part('U1', 10.1234, 20.5678), rotation: 90, mirror: 'y' }];
  const report = schematicDrafting(circuit);
  const component = report.components.items[0];
  assert.deepEqual(component.position, { x: 10.1234, y: 20.5678 });
  assert.deepEqual(
    component.pins.items.map((pin) => [pin.number, pin.name, pin.position, pin.hidden]),
    [
      ['1', 'A', { x: 11.3934, y: 25.6478 }, false],
      ['2', 'B', { x: 11.3934, y: 15.4878 }, false],
      ['3', 'Hidden', { x: 10.1234, y: 20.5678 }, true],
    ],
  );
  assert.deepEqual(component.bodyBounds, { x: 7.1234, y: 16.5678, width: 4, height: 6 });
  circuit.parts[0].mirror = 'x';
  assert.deepEqual(schematicDrafting(circuit).components.items[0].pins.items[0].position, {
    x: 8.8534,
    y: 15.4878,
  });
  assert.deepEqual(schematicDrafting(circuit).components.items[0].bodyBounds, {
    x: 9.1234,
    y: 18.5678,
    width: 4,
    height: 6,
  });
});

test('query packets are independent of input and of later packets, including declared limits', () => {
  const { circuit } = labelledStubs();
  const before = JSON.stringify(circuit);
  const expected = schematicDrafting(circuit);
  const observed = schematicDrafting(circuit);
  observed.components.items[0].pins.items[0].position.x += 100;
  observed.wires.items[0].a.x += 100;
  observed.labels.items[0].position.x += 100;
  observed.labelLinks.items[0].islands.items[0].pins.items[0].reference = 'Poison';
  (observed.limits as { wires: number }).wires = 0;
  assert.equal(JSON.stringify(circuit), before);
  assert.deepEqual(schematicDrafting(circuit), expected);

  Object.freeze(circuit);
  circuit.parts[0].x += 1.27;
  assert.notDeepEqual(schematicDrafting(circuit), expected);
});

test('large observations report totals and truncation instead of presenting partial geometry as complete', () => {
  const circuit = emptyCircuit();
  circuit.libraries['Test:Block'] = symbol();
  circuit.parts = Array.from({ length: 257 }, (_, index) =>
    part(`R${index + 1}`, index * 20.32, 0),
  );
  circuit.wires = Array.from({ length: 2050 }, (_, index) => ({
    id: uid(),
    a: { x: index * 10, y: 5000 },
    b: { x: index * 10 + 1, y: 5000 },
  }));
  circuit.labels = circuit.wires.map((wire, index) => ({
    id: uid(),
    ...wire.a,
    text: `NET${index}`,
  }));
  const report = schematicDrafting(circuit);
  assert.equal(report.components.total, 257);
  assert.equal(report.components.items.length, 256);
  assert.equal(report.components.truncated, true);
  assert.equal(report.wires.total, 2050);
  assert.equal(report.wires.items.length, 2048);
  assert.equal(report.labels.total, 2050);
  assert.equal(report.labels.items.length, 2048);
  assert.equal(report.truncated, true);
  assert.ok(report.notes.some((note) => /truncated/.test(note)));
});

test('large pin banks have explicit per-symbol and packet-wide omission information', () => {
  const circuit = emptyCircuit();
  circuit.libraries['Test:Block'] = parseSExpr(`(symbol "Test:Block" (symbol "Block_1_1"
    ${Array.from({ length: 300 }, (_, index) => `(pin passive line (at ${index * 1.27} 0 0) (length 1.27) (number "${index + 1}") (name "P${index + 1}"))`).join('\n')}))`);
  circuit.parts = Array.from({ length: 20 }, (_, index) => part(`U${index + 1}`, index * 1000, 0));
  const report = schematicDrafting(circuit);
  assert.equal(report.counts.pins, 6000);
  assert.equal(report.components.items[0].pins.total, 300);
  assert.equal(report.components.items[0].pins.items.length, 256);
  assert.equal(report.components.items[0].pins.truncated, true);
  assert.equal(
    report.components.items.reduce((count, component) => count + component.pins.items.length, 0),
    4096,
  );
  assert.equal(report.truncated, true);
});

test('label aliases cannot multiply island detail beyond the packet-wide reference budget', () => {
  const circuit = emptyCircuit();
  circuit.libraries['Test:Block'] = symbol();
  circuit.parts = Array.from({ length: 40 }, (_, index) =>
    part(`R${index + 1}`, index * 20.32, 20.32),
  );
  for (const component of circuit.parts) {
    const anchor = pinPositions(component, circuit.libraries[component.libId])[0];
    const end = { x: anchor.x - 2.54, y: anchor.y };
    circuit.wires.push({ id: uid(), a: anchor, b: end });
    for (let index = 0; index < 100; index++)
      circuit.labels.push({ id: uid(), ...end, text: `ALIAS${index}` });
  }
  const report = schematicDrafting(circuit);
  const detailReferences = report.labelLinks.items.reduce(
    (sum, link) =>
      sum +
      link.islands.items.reduce(
        (count, island) =>
          count +
          island.pins.items.length +
          island.wireIds.items.length +
          island.labelIds.items.length,
        0,
      ),
    0,
  );
  assert.equal(report.counts.labelLinkedNets, 100);
  assert.equal(report.counts.singlePinStubIslands, 40);
  assert.equal(report.labelLinks.items[99].physicalIslandCount, 40);
  assert.equal(report.labelLinks.items[99].componentPinCount, 40);
  assert.equal(detailReferences, 4096);
  assert.ok(
    report.labelLinks.items.some((link) =>
      link.islands.items.some((island) => island.pins.truncated),
    ),
  );
  assert.equal(report.truncated, true);
});
