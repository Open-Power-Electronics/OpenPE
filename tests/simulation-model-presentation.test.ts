import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  simulationLibraryForPath,
  simulationLibraryPath,
  simulationComponentPresentation,
} from '../lib/simulation-model-presentation';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createHomeExample } from '../lib/create-home-example';
import { createReferenceExample } from '../lib/reference-examples';
import { switchingStageFixture } from './fixtures/switching-stage';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { partFields } from '../lib/library';
import PartProperties from '../components/PartProperties';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
    const html = renderToStaticMarkup(
      createElement(PartProperties, { part, spiceAvailable: true, onSave: () => true }),
    );
    assert.doesNotMatch(html, /Default model|placeholder="Default"/);
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
  const part = circuit.parts.find((p) => p.ref === 'C4')!;
  const html = renderToStaticMarkup(
    createElement(PartProperties, { part, circuit, spiceAvailable: true, onSave: () => true }),
  );
  assert.match(html, /placeholder="24"/);
  assert.match(html, /aria-label="Initial voltage \(V\)"[^>]*value="24"/);
  assert.doesNotMatch(html, /Default model|placeholder="Default"/);
  assert.equal(
    simulationComponentPresentation(
      circuit.parts.find((p) => p.ref === 'Q1')!,
      circuit,
    ).model,
    'EMC_IRF520N',
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
