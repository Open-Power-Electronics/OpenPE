import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutFootprintLayerPasses } from '../components/layoutLayerPasses';
import type { BoardLayer, BoardLine, Footprint, PCB } from '../lib/pcb';
import { defaultPCBDisplay, pcbLayerPaintOrder } from '../lib/pcb-display';

const id = '00000000-0000-4000-8000-000000000001';
const footprint = (): Footprint => ({
  id,
  symbolId: null,
  libraryId: 'Fixture:Stack',
  reference: 'J1',
  x: 4,
  y: 6,
  rotation: 0,
  side: 'front',
  pads: [],
  graphics: [],
});
const board = (part: Footprint, fourLayer = false): Pick<PCB, 'layers' | 'footprints'> => ({
  layers: fourLayer ? ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] : ['F.Cu', 'B.Cu'],
  footprints: [part],
});
const line = (layer: BoardLayer): BoardLine => ({
  id: `line-${layer}`,
  layer,
  start: { x: 0, y: 0 },
  end: { x: 2, y: 1 },
  width: 0.1,
});
const text = (layer: BoardLayer, property?: string, hidden = false): BoardLine => ({
  ...line(layer),
  id: `text-${layer}-${property ?? 'caption'}`,
  kind: 'text',
  text: {
    value: property ?? 'Caption',
    rotation: 0,
    size: { x: 1, y: 1 },
    thickness: 0.15,
    property,
    hidden,
  },
});
const through = (): Footprint['pads'][number] => ({
  id: '00000000-0000-4000-8000-000000000002',
  x: 0,
  y: 0,
  number: '1',
  rotation: 0,
  type: 'thru_hole',
  shape: 'circle',
  size: { x: 2, y: 2 },
  drill: 0.8,
  netId: null,
});

test('footprint passes contain only actual layers and retain native object references', () => {
  const part = footprint();
  part.graphics = [line('B.Cu'), line('F.SilkS'), text('F.Fab', 'Value')];
  const display = defaultPCBDisplay();
  const result = layoutFootprintLayerPasses(
    board(part),
    display,
    pcbLayerPaintOrder(['F.Fab', 'F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'Edge.Cuts']),
  );
  assert.deepEqual(
    result.graphics.map((pass) => pass.layer),
    ['B.Cu', 'F.SilkS'],
  );
  assert.deepEqual(
    result.captions.map((pass) => pass.layer),
    ['F.SilkS', 'F.Fab'],
  );
  for (const pass of [...result.graphics, ...result.captions]) {
    assert.equal(pass.id, `${part.id}:${pass.layer}`);
    assert.equal(pass.footprint, part);
  }
});

test('two- and four-layer through pads have a single topmost visible owner', () => {
  for (const fourLayer of [false, true]) {
    const part = footprint();
    part.pads = [through()];
    const pcb = board(part, fourLayer);
    const physical = pcbLayerPaintOrder(pcb.layers);
    const passes = (display = defaultPCBDisplay(), order = physical) =>
      layoutFootprintLayerPasses(pcb, display, order).graphics;
    assert.deepEqual(
      passes().map((pass) => pass.layer),
      ['F.Cu'],
    );
    assert.deepEqual(
      passes({ ...defaultPCBDisplay(), 'F.Cu': false }).map((pass) => pass.layer),
      [fourLayer ? 'In1.Cu' : 'B.Cu'],
    );
    assert.deepEqual(
      passes(defaultPCBDisplay(), [...physical.filter((layer) => layer !== 'B.Cu'), 'B.Cu']).map(
        (pass) => pass.layer,
      ),
      ['B.Cu'],
    );
  }
});

test('surface pads and non-plated holes retain their independent physical ownership', () => {
  const part = footprint();
  part.side = 'back';
  part.pads = [
    { ...through(), type: 'smd', drill: undefined },
    { ...through(), id: '00000000-0000-4000-8000-000000000003', type: 'np_thru_hole' },
  ];
  const order = pcbLayerPaintOrder(['F.Cu', 'B.Cu', 'Edge.Cuts']);
  const display = defaultPCBDisplay();
  assert.deepEqual(
    layoutFootprintLayerPasses(board(part), display, order).graphics.map((pass) => pass.layer),
    ['B.Cu', 'Edge.Cuts'],
  );
  assert.deepEqual(
    layoutFootprintLayerPasses(board(part), { ...display, 'Edge.Cuts': false }, order).graphics.map(
      (pass) => pass.layer,
    ),
    ['B.Cu'],
  );
});

test('native Reference fields suppress fabricated fallback captions even when hidden', () => {
  const part = footprint();
  const order = pcbLayerPaintOrder(['F.Cu', 'F.SilkS', 'F.Fab']);
  const display = defaultPCBDisplay();
  assert.deepEqual(
    layoutFootprintLayerPasses(board(part), display, order).captions.map((pass) => pass.layer),
    ['F.SilkS'],
  );
  part.graphics = [text('F.Fab', 'Reference', true)];
  assert.deepEqual(layoutFootprintLayerPasses(board(part), display, order).captions, []);
  part.graphics = [text('F.Fab', 'Reference')];
  assert.deepEqual(
    layoutFootprintLayerPasses(board(part), display, order).captions.map((pass) => pass.layer),
    ['F.Fab'],
  );
  assert.deepEqual(
    layoutFootprintLayerPasses(board(part), { ...display, 'F.Fab': false }, order).captions,
    [],
  );
});

test('back-side fallback captions and embedded zone outlines follow their display toggles', () => {
  const part = footprint();
  part.side = 'back';
  part.zones = [
    {
      id: '00000000-0000-4000-8000-000000000004',
      layer: 'B.Cu',
      netId: null,
      outline: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 1, y: 2 },
      ],
      clearance: 0.2,
      minThickness: 0.1,
      thermalGap: 0.2,
      thermalBridge: 0.2,
    },
  ];
  const display = defaultPCBDisplay();
  const order = pcbLayerPaintOrder(['B.Cu', 'F.Cu', 'B.SilkS', 'F.SilkS']);
  const result = layoutFootprintLayerPasses(board(part), display, order);
  assert.deepEqual(
    result.graphics.map((pass) => pass.layer),
    ['B.Cu'],
  );
  assert.deepEqual(
    result.captions.map((pass) => pass.layer),
    ['B.SilkS'],
  );
  assert.deepEqual(
    layoutFootprintLayerPasses(
      board(part),
      { ...display, zoneOutlines: false, 'B.SilkS': false },
      order,
    ),
    { graphics: [], captions: [] },
  );
  assert.deepEqual(
    layoutFootprintLayerPasses(board(part), { ...display, footprints: false }, order),
    { graphics: [], captions: [] },
  );
});

test('pass grouping is independent of artwork source order and omits unmounted layers', () => {
  const part = footprint();
  part.graphics = [line('F.SilkS'), text('F.Fab', 'Value'), line('B.Cu'), line('F.Cu')];
  const display = defaultPCBDisplay();
  const order = pcbLayerPaintOrder(['F.Cu', 'B.Cu', 'F.SilkS']);
  const expected = layoutFootprintLayerPasses(board(part), display, order);
  const reversed = { ...part, graphics: part.graphics.toReversed() };
  const actual = layoutFootprintLayerPasses(board(reversed), display, order);
  assert.deepEqual(
    actual.graphics.map((pass) => pass.id),
    expected.graphics.map((pass) => pass.id),
  );
  assert.deepEqual(
    actual.captions.map((pass) => pass.id),
    expected.captions.map((pass) => pass.id),
  );
  assert.ok(actual.captions.every((pass) => pass.layer !== 'F.Fab'));
});

test('pass preparation never mutates native data or presentation inputs', () => {
  const part = footprint();
  part.graphics = [line('F.Cu')];
  part.pads = [through()];
  const pcb = board(part, true);
  const display = Object.freeze(defaultPCBDisplay());
  const order = Object.freeze(pcbLayerPaintOrder(['F.Cu', 'B.Cu', 'F.SilkS', 'F.Cu']));
  const before = JSON.stringify([pcb, display, order]);
  const first = layoutFootprintLayerPasses(pcb, display, order);
  const second = layoutFootprintLayerPasses(pcb, display, order);
  assert.equal(JSON.stringify([pcb, display, order]), before);
  assert.notEqual(first.graphics, second.graphics);
  assert.notEqual(first.captions, second.captions);
  assert.notEqual(first.graphics[0], second.graphics[0]);
  assert.equal(first.graphics[0].footprint, part);
  assert.equal(new Set(first.graphics.map((pass) => pass.id)).size, first.graphics.length);
});
