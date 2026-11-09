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

test('General keeps the value read-only when the SPICE tab owns source parameters', () => {
  const project = createExample('kicad-buck');
  for (const ref of ['V102', 'V101']) {
    const part = project.schematic.parts.find((part) => part.ref === ref)!;
    const before = structuredClone(part);
    const html = renderToStaticMarkup(
      createElement(PartProperties, { part, spiceAvailable: true, onSave: () => true }),
    );
    assert.match(html, /aria-label="SPICE" aria-selected="false"/);
    assert.doesNotMatch(html, /aria-label="(?:Pulsed )?[Vv]oltage \(V\)"/);
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

test('the SPICE tab requires plugin availability and starts unmounted', () => {
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
    assert.doesNotMatch(html, /aria-label="SPICE"|property-simulation|role="switch"/);
    assert.match(html, /Component value/);
  }
  const enabled = renderToStaticMarkup(
    createElement(PartProperties, {
      part,
      spiceAvailable: true,
      onSave: () => true,
    }),
  );
  assert.match(enabled, /aria-label="General" aria-selected="true"/);
  assert.match(enabled, /aria-label="SPICE" aria-selected="false"/);
  assert.doesNotMatch(enabled, /role="switch"|Include .*in SPICE simulation/);
  assert.doesNotMatch(enabled, /property-simulation|Simulation model/);
  assert.deepEqual(part, original, 'Plugin UI visibility preserves all accepted attributes.');
});

test('Layout linked component properties share the SPICE plugin gate and preserve ordinary fields', () => {
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
  const render = (spiceAvailable: boolean) =>
    renderToStaticMarkup(
      createElement(LayoutProperties, {
        board,
        schematic,
        footprint,
        spiceAvailable,
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
  const disabled = render(false);
  const enabled = render(true);
  for (const html of [disabled, enabled]) {
    assert.match(html, /Component reference/);
    assert.match(html, /Component value/);
    assert.doesNotMatch(html, /property-simulation|Include in SPICE simulation/);
  }
  assert.doesNotMatch(disabled, /aria-label="SPICE"/);
  assert.match(enabled, /aria-label="SPICE" aria-selected="false"/);
  assert.deepEqual(schematic, original);
});
