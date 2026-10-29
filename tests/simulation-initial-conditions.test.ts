import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPart, emptyCircuit } from '../lib/circuit';
import { partFields, displayPartValue } from '../lib/library';
import { preparePartProperties } from '../lib/part-properties';
import { createProject, projectFromNativeFiles } from '../lib/project';
import { ProjectCore } from '../core/project-core';
import { createExample } from '../lib/examples';
import { createReferenceExample } from '../lib/reference-examples';
import { createHomeExample } from '../lib/create-home-example';
import { switchingStageFixture } from './fixtures/switching-stage';
import { storagePrimitive, initialConditionField } from '../lib/simulation-initial-conditions';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import PartProperties from '../components/PartProperties';
import type { KiCadProjectFiles } from '../lib/kicad-project';
import { parseProject as serviceParse } from '../server/project-format.mjs';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';

test('every capacitor and inductor exposes its applicable optional initial condition without dirtying inspection', () => {
  for (const [kind, name, label] of [
    ['C', 'OpenPE.InitialVoltage', 'Initial voltage (V)'],
    ['L', 'OpenPE.InitialCurrent', 'Initial current (A)'],
  ] as const) {
    const circuit = emptyCircuit(),
      part = createPart(circuit, kind, 0, 0);
    circuit.parts.push(part);
    const fields = partFields(part),
      before = structuredClone(part);
    const html = renderToStaticMarkup(
      createElement(PartProperties, { part, spiceAvailable: true, onSave: () => true }),
    );
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.match(html, /placeholder="Computed"/);
    const rows = [
      ...Object.entries(fields).map(([name, value]) => ({ name, value })),
      { name, value: '' },
    ];
    assert.equal(preparePartProperties(part, part.ref, displayPartValue(part), rows), null);
    assert.deepEqual(part, before);
    const core = new ProjectCore(createProject(circuit));
    const baseline = core.getSnapshot().source;
    const change = preparePartProperties(
      part,
      part.ref,
      displayPartValue(part),
      rows.map((row) => (row.name === name ? { ...row, value: '2m' } : row)),
    )!;
    core.execute('part.properties', {
      schematicId: circuit.id,
      partId: part.id,
      fields: Object.entries(change.fields).map(([name, value]) => ({ name, value })),
    });
    const saved = projectFromNativeFiles(core.query('source.files') as KiCadProjectFiles);
    assert.equal(partFields(saved.schematic.parts[0])[name], '2m');
    assert.equal(
      partFields(serviceParse(core.getSnapshot().source).schematic.parts[0])[name],
      '2m',
    );
    const accepted = core.getSnapshot().project!.schematic.parts[0];
    const cleared = preparePartProperties(
      accepted,
      accepted.ref,
      displayPartValue(accepted),
      Object.entries(partFields(accepted)).map(([key, value]) => ({
        name: key,
        value: key === name ? '' : value,
      })),
    )!;
    assert.equal(cleared.fields[name], undefined);
    core.undo();
    assert.equal(core.getSnapshot().source, baseline);
  }
  const circuit = emptyCircuit(),
    resistor = createPart(circuit, 'R', 0, 0);
  const html = renderToStaticMarkup(
    createElement(PartProperties, { part: resistor, spiceAvailable: true, onSave: () => true }),
  );
  assert.doesNotMatch(html, /aria-label="Initial (?:voltage|current)/);
});

test('ideal, model Buck and curated compilers apply capacitor voltage and inductor current with UIC', () => {
  for (const circuit of [
    switchingStageFixture(),
    createExample('kicad-buck').schematic,
    createReferenceExample('reference-lm2596-to220-5-buck').schematic,
  ]) {
    for (const kind of ['C', 'L'] as const) {
      const part = circuit.parts.find((part) => storagePrimitive(part) === kind)!;
      part.fields = {
        ...partFields(part),
        [initialConditionField(kind)]: kind === 'C' ? '1.5' : '2m',
      };
    }
    const config = defaultTransient(circuit),
      deck = buildSpiceDeck(circuit, config);
    assert.match(deck.netlist, /^C\d+ .* IC=1\.5$/m);
    assert.match(deck.netlist, /^L\d+ .* IC=0\.002$/m);
    assert.match(deck.netlist, /^tran .* uic$/m);
    assert.deepEqual(serviceDeck(circuit, config), deck);
  }
});

test('EMC applies modeled capacitor overrides and explicitly rejects omitted-device initial conditions', () => {
  const circuit = createHomeExample('emc-flyback-demo').schematic;
  const capacitor = circuit.parts.find((part) => part.ref === 'C4')!;
  capacitor.fields = { ...partFields(capacitor), 'OpenPE.InitialVoltage': '1.5' };
  const config = defaultTransient(circuit);
  assert.match(buildSpiceDeck(circuit, config).netlist, /^C4 .* IC=1\.5$/m);
  const coil = circuit.parts.find((part) => part.ref === 'L2')!;
  coil.fields = { ...partFields(coil), 'OpenPE.InitialCurrent': '2m' };
  assert.throws(() => buildSpiceDeck(circuit, config), /L2: initial conditions are not supported/);
});
