import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceExample, referenceExamples } from '../lib/reference-examples';
import { parseProject, serializeProject, importDocument, exportKiCad } from '../lib/project';
import { readFileSync } from 'node:fs';
import manifest from '../resources/example-catalog/manifest.json';
import { symbolRole } from '../lib/symbol-role';
import { buildSpiceDeck, defaultTransient, simulationSupportError, spiceNets } from '../lib/spice';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';
import { createPart, pinPositions, libraries, type Circuit, type Point } from '../lib/circuit';
import { samePoint } from '../lib/wiring';
import { partFields, partFootprint, unitGraphics } from '../lib/library';
import lock from '../resources/reference-models-lock.json';
import { lm2596AdjustableDerivedModel, tiModels } from '../lib/ti-dcdc';
import type { ProjectDocument } from '../lib/project-document';

function connectorRowSeparator(circuit: Circuit) {
  const connectors = circuit.parts.filter(
    (part) => /^J\d+$/.test(part.ref) && /^Connector(?:_|:)/.test(part.libId),
  );
  const connectorIds = new Set(connectors.map((part) => part.id));
  const rowBottom = Math.max(
    ...connectors.flatMap((part) =>
      pinPositions(part, circuit.libraries[part.libId]).map((pin) => pin.y),
    ),
  );
  const circuitTop = Math.min(
    ...circuit.parts
      .filter((part) => !connectorIds.has(part.id) && !part.libId.startsWith('power:'))
      .flatMap((part) => [
        part.y,
        ...pinPositions(part, circuit.libraries[part.libId]).map((pin) => pin.y),
      ]),
  );
  assert.ok(circuitTop > rowBottom, 'The connector row is separate from the physical circuit.');
  return (rowBottom + circuitTop) / 2;
}

for (const entry of referenceExamples)
  test(`${entry.id}: visible source/load, identified model and service-identical deck`, () => {
    const project = parseProject(serializeProject(createReferenceExample(entry.id)));
    const before = serializeProject(project),
      d = project.schematic;
    const source = d.parts.find((p) => p.ref === 'V1')!,
      controller = d.parts.find((p) => p.ref === 'U1')!;
    const model = [...tiModels, ...lock.models].find((m) => m.id === entry.modelId)!;
    assert.ok(model);
    const derived = entry.modelId === lm2596AdjustableDerivedModel.sourceModelId;
    assert.equal(
      partFields(controller)['Sim.Name'],
      derived ? lm2596AdjustableDerivedModel.subcircuit : model.subcircuit,
    );
    assert.equal(
      partFields(controller)['Sim.Library'],
      derived ? lm2596AdjustableDerivedModel.library : `TI:${model.id}`,
    );
    assert.ok(source.libId.startsWith('Simulation_SPICE:V'));
    assert.equal(spiceNets(d).node(source, '2'), '0');
    const loads = d.parts.filter(
      (p) => p.libId === 'Device:R' && !project.pcb!.footprints.some((f) => f.symbolId === p.id),
    );
    assert.equal(loads.length, entry.id.includes('lm25017') ? 2 : 1);
    for (const load of loads) {
      assert.equal(load.value, entry.id.includes('tps61046') ? '1000' : '100');
      assert.equal(spiceNets(d).node(load, '2'), '0');
    }
    const upstream = manifest.examples.find((e) => e.id === entry.id)!;
    const original = importDocument(readFileSync(upstream.source.schematic.path, 'utf8')).schematic;
    const rowSeparator = connectorRowSeparator(original);
    for (const part of original.parts.filter((part) => part.y > rowSeparator)) {
      const retained = d.parts.find(
        (p) => p.ref === part.ref && (p.unit ?? 1) === (part.unit ?? 1),
      )!;
      assert.deepEqual(
        [retained.x, retained.y, retained.rotation],
        [part.x, part.y, part.rotation],
      );
    }
    const connectors = d.parts.filter(
      (part) => /^J\d+$/.test(part.ref) && /^Connector(?:_|:)/.test(part.libId),
    );
    const connectorPins = connectors.flatMap((part) => pinPositions(part, d.libraries[part.libId]));
    const rowCenter =
      (Math.min(...connectorPins.map((pin) => pin.y)) +
        Math.max(...connectorPins.map((pin) => pin.y))) /
      2;
    assert.ok(source.x > Math.max(...connectors.map((part) => part.x)));
    assert.ok(Math.abs(source.y - Math.round(rowCenter / 1.27) * 1.27) < 1e-8);
    const orderedBench = [source, ...loads].sort((a, b) => a.x - b.x);
    for (let i = 1; i < orderedBench.length; i++)
      assert.ok(orderedBench[i].x > orderedBench[i - 1].x);
    for (const part of [source, ...loads]) {
      assert.equal(partFootprint(part), '', `${part.ref} is a virtual testbench component.`);
      assert.equal(symbolRole(d.libraries[part.libId], part), 'virtual');
      assert.equal(part.y, source.y, 'Source and loads share the connector row center.');
      assert.ok(Math.abs(part.x / 1.27 - Math.round(part.x / 1.27)) < 1e-8);
      assert.ok(Math.abs(part.y / 1.27 - Math.round(part.y / 1.27)) < 1e-8);
    }
    assert.equal(simulationSupportError(d), '');
    const config = defaultTransient(d);
    assert.equal(
      config.stop,
      ['reference-tps61046', 'reference-lm27761'].includes(entry.modelId) ? 0.002 : 0.01,
      'Home timing follows the declared model scenario.',
    );
    assert.equal(config.step, entry.modelId === 'reference-lm5001' ? 1e-8 : 2e-7);
    const deck = buildSpiceDeck(d, config);
    assert.match(
      deck.netlist,
      /^\.options itl4=50 reltol=0\.005 method=gear(?: |$)/m,
      'All reference model bindings share the same integration and convergence policy.',
    );
    assert.deepEqual(serviceDeck(d, config), deck);
    assert.deepEqual(deck.modelIds, [entry.modelId]);
    assert.equal(serializeProject(project), before);
    controller.fields!['Sim.Pins'] = '1=1';
    assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), /pin assignment/);
  });

for (const entry of referenceExamples)
  test(`${entry.id}: testbench rails and triangular grounds share aligned native wire endpoints`, () => {
    const project = createReferenceExample(entry.id, (identifier) => identifier);
    const upstream = manifest.examples.find((item) => item.id === entry.id)!;
    const original = importDocument(readFileSync(upstream.source.schematic.path, 'utf8')).schematic;
    const originalLabels = new Set(original.labels.map((label) => label.id));
    const originalWires = new Set(original.wires.map((wire) => wire.id));
    const originalParts = new Set(original.parts.map((part) => part.id));
    const rowSeparator = connectorRowSeparator(original);
    const lowerLabels = new Set(
      original.labels.filter((label) => label.y > rowSeparator).map((label) => label.id),
    );
    const lowerWires = new Set(
      original.wires
        .filter((wire) => wire.a.y > rowSeparator && wire.b.y > rowSeparator)
        .map((wire) => wire.id),
    );
    const bench = project.schematic.parts.filter(
      (part) =>
        part.ref === 'V1' ||
        (part.libId === 'Device:R' &&
          !project.pcb!.footprints.some((footprint) => footprint.symbolId === part.id)),
    );
    assert.ok(bench.length >= 2);
    assert.equal(
      project.schematic.labels.filter((label) => !originalLabels.has(label.id)).length,
      bench.length,
      'Each added component needs one positive rail label and a ground symbol.',
    );
    assert.ok(
      project.schematic.labels
        .filter((label) => !originalLabels.has(label.id))
        .every((label) => /^(?:VIN|VOUT\d*)$/.test(label.text)),
      'Added grounds use symbols rather than GND text aliases.',
    );
    const benchPins = bench.flatMap((part) =>
      pinPositions(part, project.schematic.libraries[part.libId]),
    );
    assert.equal(
      project.schematic.wires.filter(
        (wire) =>
          !originalWires.has(wire.id) &&
          benchPins.some((pin) => samePoint(pin, wire.a) || samePoint(pin, wire.b)),
      ).length,
      bench.length * 2,
    );
    assert.equal(
      project.schematic.parts.filter(
        (part) => part.libId === 'power:GND' && !originalParts.has(part.id),
      ).length,
      bench.length,
    );
    assert.equal(
      new Set(project.schematic.parts.map((part) => `${part.ref}:${part.unit ?? 1}`)).size,
      project.schematic.parts.length,
      'Added power references are unique.',
    );
    const labelGeometry = (circuit: Circuit) =>
      circuit.labels
        .filter((label) => lowerLabels.has(label.id))
        .map(({ raw: _raw, ...label }) => label)
        .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      labelGeometry(project.schematic),
      labelGeometry(original),
      'Lower circuit rail labels retain their IDs and geometry.',
    );
    const wireGeometry = (circuit: Circuit) =>
      circuit.wires
        .filter((wire) => lowerWires.has(wire.id))
        .map(({ id, a, b }) => ({ id, a, b }))
        .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      wireGeometry(project.schematic),
      wireGeometry(original),
      'The connector row arrangement does not change lower circuit wiring.',
    );

    const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-8;
    const verifyConnections = (circuit: Circuit) => {
      const nets = spiceNets(circuit);
      const source = circuit.parts.find((part) => part.ref === 'V1')!;
      const [sourcePositive, sourceNegative] = pinPositions(
        source,
        circuit.libraries[source.libId],
      );
      const railY = sourcePositive.y - 2.54;
      const groundY = sourceNegative.y + 2.54;
      for (const benchPart of bench) {
        const part = circuit.parts.find((candidate) => candidate.id === benchPart.id)!;
        const [positive, negative] = pinPositions(part, circuit.libraries[part.libId]);
        const labelPoint = { x: positive.x, y: railY };
        const groundPoint = { x: negative.x, y: groundY };
        const labels = circuit.labels.filter((label) => same(label, labelPoint));
        assert.equal(labels.length, 1, `${part.ref} has a separate positive rail label.`);
        assert.match(labels[0].text, part.ref === 'V1' ? /^VIN$/ : /^VOUT\d*$/);
        assert.ok(
          Math.abs(labels[0].y - railY) < 1e-8,
          'The supply and every load share the same positive rail label height.',
        );
        assert.ok(!circuit.labels.some((label) => same(label, positive) || same(label, negative)));
        const grounds = circuit.parts.filter(
          (candidate) =>
            candidate.libId === 'power:GND' &&
            pinPositions(candidate, circuit.libraries[candidate.libId]).some((pin) =>
              same(pin, groundPoint),
            ),
        );
        assert.equal(grounds.length, 1, `${part.ref} has a separate ground symbol.`);
        const ground = grounds[0];
        assert.ok(
          Math.abs(pinPositions(ground, circuit.libraries[ground.libId])[0].y - groundY) < 1e-8,
          'The supply and every load share the same ground anchor height.',
        );
        assert.equal(ground.rotation, 0);
        assert.equal(symbolRole(circuit.libraries[ground.libId], ground), 'marker');
        assert.equal(partFootprint(ground), '');
        assert.deepEqual(
          unitGraphics(circuit.libraries[ground.libId], 1),
          unitGraphics(libraries['power:GND'], 1),
          'Ground uses the official triangular KiCad symbol.',
        );
        for (const [pin, endpoint, length] of [
          [positive, labelPoint, positive.y - labelPoint.y],
          [negative, groundPoint, groundPoint.y - negative.y],
        ] as const) {
          assert.ok(length >= 2.54 - 1e-8, `${part.ref} keeps at least 2.54 mm of lead clearance.`);
          if (part.ref === 'V1')
            assert.ok(Math.abs(length - 2.54) < 1e-8, 'The supply leads remain exactly 2.54 mm.');
          assert.equal(
            circuit.wires.filter(
              (wire) =>
                (same(wire.a, pin) && same(wire.b, endpoint)) ||
                (same(wire.b, pin) && same(wire.a, endpoint)),
            ).length,
            1,
            `${part.ref} connects its pin to the shared rail or ground height with one wire lead.`,
          );
        }
        assert.equal(nets.node(part, '2'), '0');
        assert.equal(nets.node(ground, '1'), '0');
        const rail = circuit.labels.find(
          (label) => originalLabels.has(label.id) && label.text === labels[0].text,
        )!;
        assert.equal(
          nets.node(part, '1'),
          nets.probeNodes().find((probe) => probe.target.id === rail.id)!.node,
          'The new wire lead still reaches the original named rail.',
        );
      }
    };
    verifyConnections(project.schematic);
    verifyConnections(importDocument(exportKiCad(project, 'schematic')).schematic);
  });

test('library placements, reference edits and load Value changes use current design content', () => {
  const d = createReferenceExample(referenceExamples[0].id).schematic;
  const r = createPart(d, 'R', 0, 0);
  r.ref = 'R99';
  r.value = '42';
  d.parts.push(r);
  const pins = pinPositions(r, d.libraries[r.libId]);
  for (const [i, text] of ['VOUT', 'GND'].entries())
    d.labels.push({ id: crypto.randomUUID(), ...pins[i], text });
  d.parts.find((p) => p.ref === 'U1')!.ref = 'U42';
  assert.equal(simulationSupportError(d), '');
  let deck = buildSpiceDeck(d, defaultTransient(d));
  assert.match(deck.netlist, /^R\d+ \S+ \S+ 42$/m);
  r.value = '84';
  deck = buildSpiceDeck(d, defaultTransient(d));
  assert.match(deck.netlist, /^R\d+ \S+ \S+ 84$/m);
  r.value = '1\n.include unsafe';
  assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), /finite numeric/);
});

test('LM2596 mapping follows vendor terminal order VIN/FB/OUT/GND/ONOFF', () => {
  const d = createReferenceExample('reference-lm2596-to220-5-buck').schematic;
  assert.equal(partFields(d.parts.find((p) => p.ref === 'U1')!)['Sim.Pins'], '1=1 4=2 2=3 3=4 5=5');
});

test('LM2598 maps the official adjustable model and retains an editable soft-start initial voltage', () => {
  const d = createReferenceExample('reference-lm2598-to220-7-buck').schematic;
  const controller = d.parts.find((part) => part.ref === 'U1')!;
  assert.equal(partFields(controller)['Sim.Pins'], '2=1 6=2 1=3 4=4 5=5 7=6 3=7');
  assert.equal(partFields(controller)['Sim.Name'], 'LM2598_ADJ_TRANS');
  assert.equal(d.parts.find((part) => part.ref === 'R1')!.value, '4.7k');
  const softStart = d.parts.find((part) => part.ref === 'C3')!;
  assert.equal(softStart.value, '0.1uF');
  assert.equal(partFields(softStart)['OpenPE.InitialVoltage'], '3');
  const config = defaultTransient(d);
  const deck = buildSpiceDeck(d, config);
  assert.deepEqual(serviceDeck(d, config), deck);
  assert.match(deck.netlist, /^C\d+ \S+ \S+ \S+ IC=3$/m);
  softStart.fields = { ...partFields(softStart), 'OpenPE.InitialVoltage': '0' };
  const discharged = buildSpiceDeck(d, config);
  assert.deepEqual(serviceDeck(d, config), discharged);
  assert.match(discharged.netlist, /^C\d+ \S+ \S+ \S+ IC=0$/m);
  assert.equal(d.parts.find((part) => part.ref === 'C3')!.value, '0.1uF');
});

test('official model input, initial condition and transient bounds reject unsafe numeric settings', () => {
  const d = createReferenceExample('reference-lm2596-to220-5-buck').schematic;
  const config = defaultTransient(d);
  assert.throws(() => buildSpiceDeck(d, { ...config, stop: 0 }), /Duration/);
  assert.throws(() => buildSpiceDeck(d, { ...config, step: 0 }), /time step/);
  const source = d.parts.find((p) => p.ref === 'V1')!;
  const original = partFields(source)['Sim.Params'];
  source.fields = { ...partFields(source), 'Sim.Params': 'dc=100' };
  assert.throws(() => buildSpiceDeck(d, config), /4.5–40 V/);
  source.fields['Sim.Params'] = original;
  const capacitor = d.parts.find((p) => p.ref === 'C1')!;
  capacitor.fields = { ...partFields(capacitor), 'OpenPE.InitialVoltage': '500' };
  assert.throws(() => buildSpiceDeck(d, config), /40 V limit/);
});

test('coupled-inductor Value, coupling and reference edits compile from current library-linked parts', () => {
  const d = createReferenceExample('reference-lm25017-wson8-flybuck').schematic;
  const coil = d.parts.find((p) => p.ref === 'L1')!;
  coil.ref = 'L42';
  coil.value = '200uH';
  coil.fields = { ...partFields(coil), 'OpenPE.Coupling': '0.9' };
  const deck = buildSpiceDeck(d, defaultTransient(d));
  for (const prefix of ['LPRI', 'LSEC']) {
    const match = deck.netlist.match(new RegExp(`^${prefix}\\d+ \\S+ \\S+ (\\S+)$`, 'm'));
    assert.ok(match && Math.abs(Number(match[1]) - 200e-6) < 1e-12);
  }
  assert.match(deck.netlist, /^K\d+ LPRI\d+ LSEC\d+ 0\.9$/m);
  coil.fields['OpenPE.Coupling'] = '2';
  assert.throws(() => buildSpiceDeck(d, defaultTransient(d)), /coupling/);
});

test('canonical component simulation edits reach renderer and service decks with numeric limits intact', () => {
  const project = createReferenceExample('reference-lm2596-to220-5-buck');
  const document: ProjectDocument = JSON.parse(serializeProject(project));
  const capacitor = document.schematic.components!.find((part) => part.reference === 'C1')!;
  assert.equal(capacitor.fields?.['OpenPE.SeriesResistance'], undefined);
  assert.equal(capacitor.fields?.['OpenPE.InitialVoltage'], undefined);
  capacitor.simulation = {
    ...capacitor.simulation,
    seriesResistance: '75m',
    initialVoltage: '2.5',
  };
  const compile = () => {
    const circuit = parseProject(JSON.stringify(document)).schematic;
    const settings = defaultTransient(circuit);
    const deck = buildSpiceDeck(circuit, settings);
    assert.deepEqual(serviceDeck(circuit, settings), deck);
    return deck.netlist;
  };
  assert.match(compile(), /^RSER\d+ \S+ series\d+ 0\.075$/m);
  assert.match(compile(), /^C\d+ \S+ \S+ \S+ IC=2\.5$/m);
  capacitor.simulation.seriesResistance = '11';
  assert.throws(compile, /series resistance/);
  capacitor.simulation.seriesResistance = '75m';
  capacitor.simulation.initialVoltage = '500';
  assert.throws(compile, /40 V limit/);

  const magnetic: ProjectDocument = JSON.parse(
    serializeProject(createReferenceExample('reference-lm25017-wson8-flybuck')),
  );
  const coil = magnetic.schematic.components!.find((part) => part.reference === 'L1')!;
  assert.equal(coil.fields?.['OpenPE.Coupling'], undefined);
  coil.simulation!.coupling = '0.9';
  const circuit = parseProject(JSON.stringify(magnetic)).schematic;
  const settings = defaultTransient(circuit);
  const deck = buildSpiceDeck(circuit, settings);
  assert.deepEqual(serviceDeck(circuit, settings), deck);
  assert.match(deck.netlist, /^K\d+ LPRI\d+ LSEC\d+ 0\.9$/m);
});
