import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyCircuit, libraries, parseCircuit, serializeCircuit } from '../lib/circuit';
import { createLibraryPart, displayPartValue, partFields } from '../lib/library';
import { preparePartProperties, simulationSourceProperties } from '../lib/part-properties';
import SchematicPartAnnotations from '../components/SchematicPartAnnotations';

test('placed waveform sources display stored parameters, update with edits and retain native Value', () => {
  const circuit = emptyCircuit();
  const library = libraries['Simulation_SPICE:VPULSE'];
  circuit.libraries['Simulation_SPICE:VPULSE'] = structuredClone(library);
  const part = createLibraryPart(circuit, library, 0, 0);
  circuit.parts.push(part);
  const original = structuredClone(part);
  const params = partFields(part)['Sim.Params'];
  assert.equal(part.value, 'VPULSE');
  assert.equal(displayPartValue(part), params);
  const rows = [
    ...Object.entries(partFields(part))
      .filter(([name]) => name !== 'Sim.Params')
      .map(([name, value]) => ({ name, value })),
    ...simulationSourceProperties(part)!.rows,
  ];
  assert.equal(preparePartProperties(part, part.ref, displayPartValue(part), rows), null);
  assert.deepEqual(part, original);
  const change = preparePartProperties(
    part,
    part.ref,
    displayPartValue(part),
    rows.map((row) =>
      'sourceKey' in row && row.sourceKey === 'y2' ? { ...row, value: '24' } : row,
    ),
  )!;
  Object.assign(part, change);
  assert.equal(part.value, 'VPULSE');
  assert.match(displayPartValue(part), /y2=24/);
  const native = serializeCircuit(circuit);
  for (const document of [circuit, parseCircuit(native)]) {
    const source = document.parts[0];
    assert.equal(source.value, 'VPULSE');
    const markup = renderToStaticMarkup(
      createElement(SchematicPartAnnotations, {
        part: source,
        library: document.libraries[source.libId],
        selected: false,
        referenceSelected: false,
        valueSelected: false,
        parameterSelected: false,
        references: true,
        values: true,
        fields: false,
        offset: () => ({ x: 0, y: 0 }),
        onPointerDown: () => {},
      }),
    );
    assert.equal(
      markup.split('y2=24').length - 1,
      1,
      'Parameters appear once before and after native reopening.',
    );
  }
  assert.equal(serializeCircuit(circuit), native, 'Rendering does not rewrite native content.');
});

test('custom source Values and active external model names remain literal', () => {
  const part = createLibraryPart(emptyCircuit(), libraries['Simulation_SPICE:VPULSE'], 0, 0);
  assert.equal(displayPartValue({ ...part, value: 'Gate drive' }), 'Gate drive');
  const external = {
    ...part,
    fields: { ...partFields(part), 'Sim.Library': 'models/vendor.lib' },
  };
  assert.equal(displayPartValue(external), 'VPULSE');
  assert.equal(
    displayPartValue({
      ...external,
      fields: { ...external.fields, 'OpenPE.ModelSource': 'basic' },
    }),
    partFields(part)['Sim.Params'],
  );
});
