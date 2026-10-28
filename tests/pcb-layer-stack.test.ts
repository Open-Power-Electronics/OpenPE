import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardLayer } from '../lib/pcb';
import {
  defaultPCBDisplay,
  pcbDisplayLayerPaintOrder,
  pcbLayerPaintOrder,
  pcbPadPaintLayer,
} from '../lib/pcb-display';

test('two- and four-layer copper stacks paint from the back toward the front', () => {
  assert.deepEqual(pcbLayerPaintOrder(['F.Cu', 'B.Cu']), ['B.Cu', 'F.Cu']);
  assert.deepEqual(pcbLayerPaintOrder(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']), [
    'B.Cu',
    'In2.Cu',
    'In1.Cu',
    'F.Cu',
  ]);
});

test('surface artwork follows its board side independently of native source order', () => {
  const physical: BoardLayer[] = [
    'B.SilkS',
    'B.Paste',
    'B.Mask',
    'B.Cu',
    'In2.Cu',
    'In1.Cu',
    'F.Cu',
    'F.Mask',
    'F.Paste',
    'F.SilkS',
  ];
  assert.deepEqual(pcbLayerPaintOrder(physical.toReversed()), physical);
  assert.deepEqual(pcbLayerPaintOrder([...physical.slice(4), ...physical.slice(0, 4)]), physical);
});

test('technical overlays have a stable order above the physical stack with board edges last', () => {
  const layers: BoardLayer[] = ['User.2', 'F.Fab', 'Edge.Cuts', 'F.Cu', 'B.CrtYd', 'User.1'];
  const expected = ['F.Cu', 'B.CrtYd', 'F.Fab', 'User.1', 'User.2', 'Edge.Cuts'];
  assert.deepEqual(pcbLayerPaintOrder(layers), expected);
  assert.deepEqual(pcbLayerPaintOrder(layers.toReversed()), expected);
});

test('paint ordering removes duplicate passes and returns an independent container', () => {
  const layers = Object.freeze<BoardLayer[]>(['F.Cu', 'B.Cu', 'F.Cu', 'Edge.Cuts']);
  const ordered = pcbLayerPaintOrder(layers);
  assert.deepEqual(ordered, ['B.Cu', 'F.Cu', 'Edge.Cuts']);
  ordered.pop();
  assert.deepEqual(layers, ['F.Cu', 'B.Cu', 'F.Cu', 'Edge.Cuts']);
  assert.deepEqual(pcbLayerPaintOrder(layers), ['B.Cu', 'F.Cu', 'Edge.Cuts']);
});

test('display paint order includes enabled latent fabrication layers without native inventory', () => {
  const display = defaultPCBDisplay();
  const order = pcbDisplayLayerPaintOrder(display);
  for (const layer of ['F.Fab', 'B.Fab', 'F.CrtYd', 'B.CrtYd'] as const)
    assert.ok(order.includes(layer), `${layer} remains available to a new footprint preview.`);
  assert.deepEqual(
    order.filter((layer) => layer.endsWith('.Cu')),
    ['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu'],
  );
  assert.equal(order.at(-1), 'Edge.Cuts');
  assert.ok(
    order.every(
      (layer) =>
        !['footprints', 'padNumbers', 'padNets', 'zoneOutlines', 'copper', 'airwires'].includes(
          layer,
        ),
    ),
  );
});

test('display paint order respects hidden layers and ignores independent object flags', () => {
  const display = Object.freeze({
    ...defaultPCBDisplay(),
    'F.Fab': false,
    'B.CrtYd': false,
    'F.Mask': true,
    footprints: false,
    copper: false,
  });
  const before = JSON.stringify(display);
  const ordered = pcbDisplayLayerPaintOrder(display);
  assert.equal(ordered.includes('F.Fab'), false);
  assert.equal(ordered.includes('B.CrtYd'), false);
  assert.ok(ordered.includes('F.Mask'));
  assert.ok(ordered.includes('F.Cu'));
  ordered.pop();
  assert.equal(JSON.stringify(display), before);
  assert.equal(pcbDisplayLayerPaintOrder(display).at(-1), 'Edge.Cuts');
});

test('spanning pads belong to the topmost visible copper pass and follow explicit priority', () => {
  const display = defaultPCBDisplay();
  const padLayers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  const physical = pcbLayerPaintOrder(padLayers as BoardLayer[]);
  assert.equal(pcbPadPaintLayer(padLayers, display, physical), 'F.Cu');
  assert.equal(
    pcbPadPaintLayer(padLayers, display, [...physical.filter((layer) => layer !== 'B.Cu'), 'B.Cu']),
    'B.Cu',
  );
  assert.equal(pcbPadPaintLayer(padLayers, { ...display, 'F.Cu': false }, physical), 'In1.Cu');
  assert.equal(
    pcbPadPaintLayer(padLayers, { ...display, 'B.Cu': false }, ['F.Cu', 'B.Cu']),
    'F.Cu',
    'A hidden prioritized layer cannot own a visible pad.',
  );
});

test('single-layer pads, mechanical holes and fully hidden pads retain exact visibility', () => {
  const display = defaultPCBDisplay();
  const physical = pcbLayerPaintOrder(['Edge.Cuts', 'F.Cu', 'B.Cu']);
  assert.equal(pcbPadPaintLayer(['B.Cu'], display, physical), 'B.Cu');
  assert.equal(pcbPadPaintLayer(['Edge.Cuts'], display, physical), 'Edge.Cuts');
  assert.equal(
    pcbPadPaintLayer(['Edge.Cuts'], { ...display, 'Edge.Cuts': false }, physical),
    undefined,
  );
  assert.equal(
    pcbPadPaintLayer(['F.Cu', 'B.Cu'], { ...display, 'F.Cu': false, 'B.Cu': false }, physical),
    undefined,
  );
  assert.equal(pcbPadPaintLayer(['F.Cu'], display, []), undefined);
});

test('pad ownership observes inputs without modifying visibility, memberships or pass order', () => {
  const display = Object.freeze(defaultPCBDisplay());
  const padLayers = Object.freeze(['F.Cu', 'B.Cu']);
  const paintOrder = Object.freeze<BoardLayer[]>(['F.Cu', 'B.Cu']);
  const before = JSON.stringify([display, padLayers, paintOrder]);
  assert.equal(pcbPadPaintLayer(padLayers, display, paintOrder), 'B.Cu');
  assert.equal(JSON.stringify([display, padLayers, paintOrder]), before);
});
