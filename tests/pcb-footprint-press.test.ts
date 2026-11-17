import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyPCB } from '../lib/pcb-layout';
import { pcbFootprintDragTarget } from '../lib/pcb-selection';
import { footprintPressCanDrag } from '../lib/selection-drag';

const board = {
  ...createEmptyPCB(),
  footprints: [
    {
      id: 'pkg',
      symbolId: null,
      libraryId: 'lib',
      x: 0,
      y: 0,
      rotation: 0,
      side: 'front' as const,
      reference: 'U1',
      value: 'U1',
      pads: [
        {
          id: 'pad',
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'smd' as const,
          shape: 'rect' as const,
          size: { x: 1, y: 1 },
          netId: 'net',
        },
      ],
      graphics: [
        {
          id: 'silk',
          layer: 'F.SilkS' as const,
          width: 0.1,
          start: { x: 0, y: 0 },
          end: { x: 1, y: 0 },
        },
        {
          id: 'yard',
          layer: 'F.CrtYd' as const,
          width: 0.05,
          start: { x: -1, y: -1 },
          end: { x: 1, y: 1 },
        },
      ],
    },
  ],
  tracks: [
    {
      id: 'trace',
      start: { x: -2, y: 0 },
      end: { x: 2, y: 0 },
      width: 0.2,
      layer: 'F.Cu' as const,
      netId: 'net',
    },
  ],
};

test('press-drag targets a footprint under copper, silk or courtyard', () => {
  assert.equal(footprintPressCanDrag('drag-selected'), true);
  assert.equal(footprintPressCanDrag('drag-any'), true);
  assert.equal(footprintPressCanDrag('select'), false);
  assert.equal(
    pcbFootprintDragTarget(board, [
      { padId: 'pad' },
      { selection: { kind: 'track', id: 'trace' } },
    ]),
    'pkg',
  );
  assert.equal(
    pcbFootprintDragTarget(board, [
      { selection: { kind: 'graphic', id: 'silk' } },
      { selection: { kind: 'track', id: 'trace' } },
    ]),
    'pkg',
  );
  assert.equal(
    pcbFootprintDragTarget(board, [{ selection: { kind: 'graphic', id: 'yard' } }]),
    'pkg',
  );
  assert.equal(
    pcbFootprintDragTarget(board, [{ selection: { kind: 'footprint', id: 'pkg' } }]),
    'pkg',
  );
  assert.equal(
    pcbFootprintDragTarget(board, [{ selection: { kind: 'track', id: 'trace' } }]),
    undefined,
  );
});
