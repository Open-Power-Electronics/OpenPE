import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  simulationLibraryForPath,
  simulationLibraryPath,
  simulationComponentPresentation,
  simulationLibraryDeclaration,
} from '../lib/simulation-model-presentation';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createHomeExample } from '../lib/create-home-example';
import { createReferenceExample } from '../lib/reference-examples';
import { switchingStageFixture } from './fixtures/switching-stage';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { partFields } from '../lib/library';

test('model lookup stays inside the selected library, with only the reviewed derivative using its pinned source declaration', () => {
  const declarations = [{ name: 'RES_A' }, { name: 'RES_B' }];
  assert.equal(
    simulationLibraryDeclaration('circuits/vendor.lib', 'RES_B', declarations),
    declarations[1],
  );
  assert.equal(
    simulationLibraryDeclaration('circuits/vendor.lib', 'MISSING', declarations),
    undefined,
  );
  const source = [{ name: 'LM2596_5P0_TRANS' }];
  assert.equal(
    simulationLibraryDeclaration(
      'OpenPE:lm2596-adj-derived',
      'OPENPE_DERIVED_LM2596_ADJ_TRANS',
      source,
    ),
    source[0],
  );
  assert.equal(
    simulationLibraryDeclaration('circuits/other.lib', 'OPENPE_DERIVED_LM2596_ADJ_TRANS', source),
    undefined,
  );
});

test('implicit models identify their primitives and computed initial states without writing design defaults', () => {
  const circuit = emptyCircuit();
  for (const [kind, model] of [
    ['R', 'ngspice R'],
    ['C', 'ngspice C'],
    ['L', 'ngspice L'],
  ] as const) {
    const part = createPart(circuit, kind, 0, 0),
      before = structuredClone(part);
    assert.equal(simulationComponentPresentation(part).model, model);
    assert.deepEqual(part, before);
  }
  const stage = switchingStageFixture(),
    capacitor = stage.parts.find((p) => p.libId === 'Device:C')!;
  assert.equal(simulationComponentPresentation(capacitor, stage).initial, 'Computed');
  const reference = createReferenceExample('reference-lm2735-msop8-sepic').schematic;
  const cap = reference.parts.find((p) => p.libId === 'Device:C')!;
  assert.equal(
    simulationComponentPresentation(cap, reference).initial,
    partFields(cap)['OpenPE.InitialVoltage'] || '0',
  );
});

test('EMC initial values and model names match the generated execution bench', () => {
  const circuit = createHomeExample('emc-flyback-demo').schematic,
    before = JSON.stringify(circuit);
  const deck = buildSpiceDeck(circuit, defaultTransient(circuit));
  const initialNodes = new Map<string, number>();
  for (const line of deck.netlist.split('\n').filter((line) => line.startsWith('.ic ')))
    for (const match of line.matchAll(/V\(([^)]+)\)=([^\s]+)/g))
      initialNodes.set(match[1], Number(match[2]));
  for (const ref of ['C4', 'C18', 'C15']) {
    const part = circuit.parts.find((p) => p.ref === ref)!;
    const tokens = deck.netlist
      .split('\n')
      .find((line) => line.startsWith(ref + ' '))!
      .split(/\s+/);
    const expected = Number(
      ((initialNodes.get(tokens[1]) || 0) - (initialNodes.get(tokens[2]) || 0)).toPrecision(12),
    );
    const presentation = simulationComponentPresentation(part, circuit);
    assert.equal(Number(presentation.initial), expected);
    assert.equal(presentation.model, 'ngspice C');
  }
  assert.equal(
    simulationComponentPresentation(
      circuit.parts.find((p) => p.ref === 'Q1')!,
      circuit,
    ).model,
    'circuits/EMC_IRF520N.lib',
  );
  assert.equal(
    simulationComponentPresentation(
      circuit.parts.find((p) => p.ref === 'L2')!,
      circuit,
    ).initial,
    'Not modeled',
  );
  assert.equal(JSON.stringify(circuit), before);
});

test('portable path presentation preserves distinct native identities sharing one model file', () => {
  for (const library of ['TI:lm2596-5', 'OpenPE:lm2596-adj-derived']) {
    assert.equal(simulationLibraryPath(library), 'circuits/LM2596-5.lib');
    assert.equal(simulationLibraryForPath('circuits/LM2596-5.lib', library), library);
  }
  assert.equal(simulationLibraryPath('TI:reference-lm25017'), 'circuits/LM25017.lib');
  assert.equal(simulationLibraryForPath('circuits/LM25017.lib', ''), 'TI:reference-lm25017');
  assert.equal(simulationLibraryPath('diode.mod'), 'circuits/diode.lib');
  const upstream = '${KICAD7_SYMBOL_DIR}/Simulation_SPICE.sp';
  assert.equal(simulationLibraryPath(upstream), 'circuits/Simulation_SPICE.lib');
  assert.equal(simulationLibraryForPath('circuits/Simulation_SPICE.lib', ''), upstream);
  const custom = 'circuits/custom.lib';
  assert.equal(simulationLibraryForPath(custom, 'TI:reference-lm25017'), custom);
  assert.equal(simulationLibraryPath(custom), custom);
});
