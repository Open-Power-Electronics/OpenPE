import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PartProperties from '../components/PartProperties';
import LayoutProperties from '../components/LayoutProperties';
import { createPart, emptyCircuit } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { Footprint } from '../lib/pcb';
import { parameterizedHomeProject } from './fixtures/model-parameters';

test('General keeps the value read-only when the SPICE tab owns source parameters', () => {
  for (const type of ['DC', 'PULSE'] as const) {
    const project = parameterizedHomeProject(type);
    const ref = 'V1';
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

test('Layout via, mechanical footprint, outline and mixed selections expose General with retained fields and actions', () => {
  for (const locked of [false, true]) {
    const schematic = emptyCircuit();
    const board = createEmptyPCB();
    const lock = locked ? { locked: true as const } : {};
    const via = {
      id: 'via',
      x: 3,
      y: 4,
      diameter: 1.2,
      drill: 0.6,
      netId: 'gnd',
      ...lock,
    };
    const footprint: Footprint = {
      id: 'mechanical',
      symbolId: null,
      libraryId: 'Fixture:MountingHole',
      reference: 'H1',
      value: 'Mounting hole',
      x: 1,
      y: 2,
      rotation: 0,
      side: 'front',
      pads: [],
      graphics: [],
      ...lock,
    };
    board.nets = [{ id: 'gnd', name: 'GND' }];
    board.vias = [via];
    board.footprints = [footprint];
    board.graphics = [
      {
        id: 'outline',
        layer: 'Edge.Cuts',
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
        width: 0.1,
        ...lock,
      },
    ];
    const unchanged = structuredClone({ board, schematic });
    const unexpectedEdit = () => {
      throw new Error('Rendering Properties must not edit the project.');
    };
    const base: ComponentProps<typeof LayoutProperties> = {
      board,
      schematic,
      active: true,
      resetKey: false,
      rectangle: null,
      selectionCount: 1,
      lockTargets: [],
      snap: (value) => value,
      actions: createElement('button', { 'aria-label': 'Delete selection' }, 'Delete'),
      onLock: unexpectedEdit,
      onCommit: unexpectedEdit,
      onFootprint: unexpectedEdit,
      onTrack: unexpectedEdit,
      onZone: unexpectedEdit,
      onRectangle: unexpectedEdit,
      onError: unexpectedEdit,
      onInspectFootprint: unexpectedEdit,
    };
    const cases: { props: Partial<typeof base>; field: RegExp }[] = [
      { props: { via, lockTargets: [{ kind: 'via', id: via.id }] }, field: /aria-label="Via net"/ },
      {
        props: { footprint, lockTargets: [{ kind: 'footprint', id: footprint.id }] },
        field: /aria-label="Footprint side"/,
      },
      {
        props: {
          rectangle: { ids: ['outline'], bounds: { minX: 0, minY: 0, maxX: 10, maxY: 8 } },
          lockTargets: [{ kind: 'graphic', id: 'outline' }],
        },
        field: /aria-label="Line width \(mm\)"/,
      },
      {
        props: {
          selectionCount: 2,
          lockTargets: [
            { kind: 'via', id: via.id },
            { kind: 'footprint', id: footprint.id },
          ],
        },
        field: /Items<\/span><output>2<\/output>/,
      },
    ];
    for (const { props, field } of cases) {
      const html = renderToStaticMarkup(createElement(LayoutProperties, { ...base, ...props }));
      const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
      assert.equal(tabs.length, 1);
      assert.match(tabs[0], /aria-label="General" aria-selected="true"/);
      assert.doesNotMatch(tabs[0], /disabled/);
      assert.match(html, field);
      assert.match(html, /<button aria-label="Delete selection">/);
      assert.equal(/class="property-tab-fields" disabled=""/.test(html), locked);
      assert.deepEqual({ board, schematic }, unchanged);
    }
    const empty = renderToStaticMarkup(
      createElement(LayoutProperties, { ...base, selectionCount: 0 }),
    );
    assert.doesNotMatch(empty, /role="tab"/);
    assert.match(empty, /Select an object to view its properties/);
  }
});
