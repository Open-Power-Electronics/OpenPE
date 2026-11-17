import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyPCB } from '../lib/pcb-layout';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { nearestMeasurementAnchor, pcbMeasurementAnchors } from '../lib/pcb-measurement';

test('measurement attracts exact off-grid native corners and ignores hidden drawing layers', () => {
  const board = createEmptyPCB();
  board.graphics = [
    {
      id: 'outline-edge',
      layer: 'Edge.Cuts',
      width: 0.05,
      start: { x: 1.23, y: 4.56 },
      end: { x: 9.87, y: 6.54 },
    },
  ];
  const before = JSON.stringify(board);
  const display = defaultPCBDisplay();
  const anchors = pcbMeasurementAnchors(board, display);
  const point = nearestMeasurementAnchor(anchors, { x: 1.3, y: 4.5 }, 0.2);
  assert.deepEqual(point, { x: 1.23, y: 4.56 });
  point!.x = 999;
  assert.equal(board.graphics[0].start.x, 1.23);
  assert.equal(nearestMeasurementAnchor(anchors, { x: 10, y: 10 }, 0.2), undefined);
  assert.equal(pcbMeasurementAnchors(board, { ...display, 'Edge.Cuts': false }).length, 0);
  assert.equal(JSON.stringify(board), before);
});

test('visible component placement centers attract off-grid points without depending on pads or captions', () => {
  const board = createEmptyPCB();
  board.footprints.push({
    id: 'part',
    symbolId: null,
    libraryId: 'local:part',
    x: 12.345,
    y: -6.789,
    rotation: 90,
    side: 'back',
    pads: [],
    graphics: [
      { id: 'body', layer: 'B.Fab', width: 0.1, start: { x: -2, y: -1 }, end: { x: 2, y: 1 } },
    ],
  });
  const before = JSON.stringify(board);
  const display = defaultPCBDisplay();
  assert.deepEqual(
    nearestMeasurementAnchor(pcbMeasurementAnchors(board, display), { x: 12.35, y: -6.8 }, 0.1),
    { x: 12.345, y: -6.789 },
  );
  assert.deepEqual(pcbMeasurementAnchors(board, { ...display, footprints: false }), []);
  assert.deepEqual(pcbMeasurementAnchors(board, { ...display, 'B.Fab': false }), []);
  assert.equal(JSON.stringify(board), before);
});
