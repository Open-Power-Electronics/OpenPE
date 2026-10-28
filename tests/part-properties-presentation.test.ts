import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PartProperties from '../components/PartProperties';
import LayoutProperties from '../components/LayoutProperties';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { Footprint } from '../lib/pcb';

function fixture() {
  const schematic = emptyCircuit();
  const part = createPart(schematic, 'R', 0, 0);
  part.fields = { Footprint: 'Resistor_SMD:R_0805_2012Metric', 'OpenPE.SeriesResistance': '50m' };
  part.excludeFromSimulation = true;
  schematic.parts.push(part);
  return { schematic, part };
}

test('SPICE participation and parameter controls require explicit Schematic plugin availability', () => {
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
  assert.match(
    enabled,
    /role="switch"[^>]*aria-label="Include in SPICE simulation"[^>]*aria-checked="false"/,
  );
  assert.match(enabled, /Series resistance \(Ω\)/);
  assert.deepEqual(part, original, 'Plugin UI visibility preserves all accepted attributes.');
});

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
