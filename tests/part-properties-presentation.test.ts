import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PartProperties from '../components/PartProperties';
import LayoutProperties from '../components/LayoutProperties';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { Footprint } from '../lib/pcb';
import { createExample } from '../lib/examples';

test('voltage sources expose typed parameter inputs with one editable owner', () => {
  const project = createExample('kicad-buck');
  for (const [ref, label] of [
    ['V102', 'Voltage (V)'],
    ['V101', 'Pulsed voltage (V)'],
  ]) {
    const part = project.schematic.parts.find((part) => part.ref === ref)!;
    const before = structuredClone(part);
    const html = renderToStaticMarkup(
      createElement(PartProperties, { part, spiceAvailable: true, onSave: () => true }),
    );
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.doesNotMatch(html, /aria-label="(?:Device|Type|Pins)"/);
    assert.match(html, /aria-label="Component value"[^>]*readOnly=""/);
    assert.doesNotMatch(html, /aria-label="Params"/);
    assert.deepEqual(part, before);
  }
});

function fixture() {
  const schematic = emptyCircuit();
  const part = createPart(schematic, 'R', 0, 0);
  part.fields = { Footprint: 'Resistor_SMD:R_0805_2012Metric', 'OpenPE.SeriesResistance': '50m' };
  part.excludeFromSimulation = true;
  schematic.parts.push(part);
  return { schematic, part };
}

test('SPICE parameters require Schematic plugin availability and participation stays outside Properties', () => {
  const { part } = fixture();
  const original = structuredClone(part);
  for (const spiceAvailable of [undefined, false]) {
    const html = renderToStaticMarkup(
      createElement(PartProperties, {
        part,
        spiceAvailable,
        onSave: () => true,
      }),
    );
    assert.doesNotMatch(html, /property-simulation|role="switch"|Series resistance \(Ω\)/);
    assert.match(html, /Component value/);
  }
  const enabled = renderToStaticMarkup(
    createElement(PartProperties, {
      part,
      spiceAvailable: true,
      onSave: () => true,
    }),
  );
  assert.match(enabled, />SPICE Simulation<\/span>/);
  assert.doesNotMatch(enabled, /role="switch"|Include .*in SPICE simulation/);
  assert.doesNotMatch(enabled, /Series resistance|Coupling|property-simulation-parameter/);
  assert.deepEqual(part, original, 'Plugin UI visibility preserves all accepted attributes.');
});

test('model dropdown and model browsing preserve native fields', () => {
  const { part } = fixture();
  part.fields = { Footprint: part.fields!.Footprint };
  for (const libId of [
    'Device:R',
    'Device:C',
    'Device:L',
    'Device:D',
    'power:GND',
    'Connector_Generic:Conn_01x02',
  ]) {
    const component = { ...part, libId };
    const original = structuredClone(component);
    const html = renderToStaticMarkup(
      createElement(PartProperties, { part: component, spiceAvailable: true, onSave: () => true }),
    );
    assert.match(html, />SPICE Simulation<\/span>/, libId);
    assert.match(html, /aria-label="Simulation model"/, libId);
    assert.match(html, /aria-label="Browse SPICE models"/, libId);
    assert.match(html, /role="combobox"/);
    assert.doesNotMatch(html, /<select[^>]*aria-label="Simulation model"/);
    assert.doesNotMatch(html, /role="radio"|>Basic<|>External</, libId);
    assert.doesNotMatch(html, /Default model|placeholder="Default"/, libId);
    assert.doesNotMatch(html, /role="switch"/);
    assert.deepEqual(component, original);
  }
});

test('File shows only the filename above Model and preserves the native assignment', () => {
  const { part } = fixture();
  part.fields!['Sim.Library'] = 'OpenPE:lm2596-adj-derived';
  const original = structuredClone(part);
  const html = renderToStaticMarkup(
    createElement(PartProperties, { part, spiceAvailable: true, onSave: () => true }),
  );
  assert.match(html, /aria-label="Browse SPICE models"/);
  assert.match(
    html,
    /<input[^>]*aria-label="Model library"[^>]*title="circuits\/LM2596-5\.lib"[^>]*readOnly=""[^>]*value="LM2596-5\.lib"/,
  );
  assert.match(html, /<span>File<\/span>/);
  assert.match(html, /<span>Model<\/span>/);
  assert.doesNotMatch(html, /Models in file/);
  assert.equal([...html.matchAll(/role="combobox"/g)].length, 1);
  assert.ok(
    html.indexOf('aria-label="Model library"') < html.indexOf('aria-label="Simulation model"'),
  );
  assert.doesNotMatch(html, /aria-label="Remove field (?:Sim\.|Series resistance)/);
  assert.doesNotMatch(html, /OpenPE:lm2596-adj-derived/);
  assert.deepEqual(part, original);
});

test('external model selection hides native binding metadata and retains omitted parameters', () => {
  const { part } = fixture();
  Object.assign(part.fields!, {
    'Sim.Device': 'SUBCKT',
    'Sim.Name': 'OPENPE_DERIVED_LM2596_ADJ_TRANS',
    'Sim.Library': 'OpenPE:lm2596-adj-derived',
    'Sim.Pins': '1=1 2=2',
  });
  const original = structuredClone(part);
  const html = renderToStaticMarkup(
    createElement(PartProperties, { part, spiceAvailable: true, onSave: () => true }),
  );
  const section = html.slice(html.indexOf('<details'));
  assert.doesNotMatch(section, /Remove field/);
  assert.doesNotMatch(section, /Series resistance|Coupling/);
  assert.doesNotMatch(section.replace(/<input\b[^>]*readOnly=""[^>]*>/g, ''), /<input/);
  assert.match(section, /class="select-value">LM2596_ADJ_TRANS<\/span>/);
  assert.doesNotMatch(section, /<select/);
  assert.doesNotMatch(section, /aria-label="(?:Device|Pins)"|SUBCKT|1=1 2=2/);
  assert.ok(section.includes('LM2596_ADJ_TRANS'));
  assert.doesNotMatch(section.replace(/<[^>]*>/g, ''), /Sim\.(?:Device|Name|Pins)|OPENPE_DERIVED_/);
  assert.deepEqual(part, original);
});

for (const [kind, field, label, otherLabel, value, display, unit] of [
  ['C', 'OpenPE.InitialVoltage', 'Initial voltage (V)', 'Initial current (A)', '2.5', '2.5', 'V'],
  ['L', 'OpenPE.InitialCurrent', 'Initial current (A)', 'Initial voltage (V)', '40m', '40', 'mA'],
] as const) {
  test(`external .MODEL ${kind} exposes its initial condition while SUBCKT hides the retained value`, () => {
    const circuit = emptyCircuit();
    const part = createPart(circuit, kind, 0, 0);
    part.fields = {
      ...part.fields,
      'Sim.Device': kind,
      'Sim.Name': `VENDOR_${kind}`,
      'Sim.Library': 'circuits/storage.lib',
      'Sim.Pins': '1=+ 2=-',
      'OpenPE.ModelSource': 'external',
      [field]: value,
    };
    circuit.parts.push(part);
    let saves = 0;
    const render = () =>
      renderToStaticMarkup(
        createElement(PartProperties, {
          part,
          circuit,
          spiceAvailable: true,
          onSave: () => {
            saves++;
            return true;
          },
        }),
      );

    const original = structuredClone(part);
    const modelHtml = render();
    const input = [...modelHtml.matchAll(/<input\b[^>]*>/g)].find(([tag]) =>
      tag.includes(`aria-label="${label}"`),
    )?.[0];
    assert.ok(input, `.MODEL ${kind} exposes ${label}.`);
    assert.equal(Number(input.match(/\bvalue="([^"]+)"/)?.[1]), Number(display));
    const unitControl = modelHtml
      .slice(modelHtml.indexOf(`aria-label="${label} unit"`))
      .split('</button>')[0];
    assert.ok(unitControl.includes(`<span class="select-value">${unit}</span>`));
    assert.doesNotMatch(input, /readOnly=|disabled=/);
    assert.ok(!modelHtml.includes(`aria-label="${otherLabel}"`));
    assert.deepEqual(part, original);

    part.fields['Sim.Device'] = 'SUBCKT';
    part.fields['Sim.Pins'] = '1=1 2=2';
    const subcircuit = structuredClone(part);
    const subcircuitHtml = render();
    assert.doesNotMatch(subcircuitHtml, /aria-label="Initial (?:voltage|current) \([VA]\)"/);
    assert.deepEqual(
      part,
      subcircuit,
      'Hiding the input preserves its accepted initial condition.',
    );
    assert.equal(part.fields[field], value);
    assert.equal(saves, 0, 'Rendering either model never applies a design edit.');
  });
}

test('Layout linked component properties omit SPICE controls while preserving ordinary fields', () => {
  const { schematic, part } = fixture();
  const board = createEmptyPCB();
  const footprint: Footprint = {
    id: 'linked-footprint',
    symbolId: part.id,
    libraryId: part.fields!.Footprint,
    x: 0,
    y: 0,
    rotation: 0,
    side: 'front',
    pads: [],
    graphics: [],
  };
  board.footprints.push(footprint);
  const original = structuredClone(schematic);
  const html = renderToStaticMarkup(
    createElement(LayoutProperties, {
      board,
      schematic,
      footprint,
      active: true,
      resetKey: false,
      rectangle: null,
      selectionCount: 1,
      lockTargets: [{ kind: 'footprint', id: footprint.id }],
      onLock: () => {},
      snap: (value) => value,
      onCommit: () => true,
      onFootprint: () => true,
      onTrack: () => true,
      onZone: () => true,
      onRectangle: () => true,
      onError: () => {},
      onInspectFootprint: () => {},
      onSavePartProperties: () => true,
    }),
  );
  assert.match(html, /Component reference/);
  assert.match(html, /Component value/);
  assert.doesNotMatch(html, /property-simulation|Include in SPICE simulation|SPICE Simulation/);
  assert.deepEqual(schematic, original);
});
