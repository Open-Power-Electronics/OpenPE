import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PCB, BoardLine } from '../lib/pcb';
import { ownProjectData } from '../lib/immutable-project';
import { createEmptyPCB, flipPCBFootprint, movePCBSelection, padPosition } from '../lib/pcb-layout';
import { defaultPCBDisplay } from '../lib/pcb-display';
import {
  defaultPCBSelectionFilters,
  selectPCBPoint,
  type PCBPointSelectionOptions,
} from '../lib/pcb-selection';
import { compareQueries } from './fixtures/pcb-point-queries';

test('owned broad phase retains rotated shapes, outlines, holes and exact epsilon boundaries', () => {
  const graphic = (id: string, kind: BoardLine['kind'], fill = false): BoardLine => ({
    id,
    kind,
    layer: 'F.SilkS',
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
    width: 0.2,
    fill,
  });
  const board: PCB = {
    ...createEmptyPCB(),
    footprints: [
      {
        id: 'part',
        libraryId: 'test',
        symbolId: null,
        x: 12,
        y: 8,
        rotation: 37,
        side: 'front',
        graphics: [],
        pads: [
          {
            id: 'pad',
            number: '1',
            x: 2,
            y: 1,
            rotation: 23,
            size: { x: 5, y: 0.8 },
            shape: 'roundrect',
            type: 'smd',
            netId: null,
          },
        ],
        zones: [
          {
            id: 'embedded',
            layer: 'F.Cu',
            netId: null,
            outline: [
              { x: -7, y: -7 },
              { x: 7, y: -7 },
              { x: 7, y: 7 },
              { x: -7, y: 7 },
            ],
            holes: [
              [
                { x: -2, y: -2 },
                { x: 2, y: -2 },
                { x: 2, y: 2 },
                { x: -2, y: 2 },
              ],
            ],
            keepout: { tracks: true, vias: true, pads: true, copperpour: true, footprints: false },
            clearance: 0.2,
            minThickness: 0.2,
            thermalGap: 0.2,
            thermalBridge: 0.2,
          },
        ],
      },
    ],
    tracks: [
      {
        id: 'locked',
        start: { x: -5, y: 2 },
        end: { x: 5, y: 2 },
        width: 0.3,
        layer: 'F.Cu',
        netId: 'n',
        locked: true,
      },
    ],
    vias: [{ id: 'via', x: 2, y: 2, diameter: 1, drill: 0.4, netId: 'n' }],
    graphics: [
      graphic('circle', 'circle'),
      { ...graphic('disk', 'circle', true), start: { x: -12, y: 0 }, end: { x: -7, y: 0 } },
      { ...graphic('arc', 'arc'), mid: { x: 2.5, y: 2.5 } },
      {
        ...graphic('poly', 'polygon', true),
        start: { x: 20, y: 0 },
        points: [
          { x: 25, y: 0 },
          { x: 25, y: 5 },
        ],
        end: { x: 20, y: 5 },
      },
      {
        ...graphic('text', 'text'),
        start: { x: 25, y: 12 },
        end: { x: 25, y: 12 },
        text: {
          value: 'A\nB',
          rotation: 45,
          size: { x: 1, y: 1 },
          thickness: 0.1,
          justify: ['mirror'],
        },
      },
    ],
  };
  board.footprints.push({
    ...flipPCBFootprint(board.footprints[0]),
    id: 'flipped',
    x: 30,
    pads: board.footprints[0].pads.map((pad) => ({ ...pad, id: 'flipped-pad' })),
    zones: [],
  });
  const points = Array.from({ length: 54 }, (_, index) => ({
    x: -18 + (index % 9) * 6,
    y: -8 + Math.floor(index / 9) * 4,
  }));
  points.push(
    { x: 5.1 + 5e-10, y: 0 },
    { x: 0, y: 2.15 + 5e-10 },
    padPosition(board.footprints[0], board.footprints[0].pads[0]),
  );
  const all = defaultPCBDisplay(),
    filters = defaultPCBSelectionFilters();
  compareQueries(
    board,
    points,
    [all, { ...all, 'F.SilkS': false }, { ...all, 'F.Cu': false }, all],
    [
      filters,
      { ...filters, locked: true, ruleArea: false },
      { ...filters, graphic: false, text: false },
    ],
  );
});

test('point caches reject foreign freezing, follow mutable previews and return independent wrappers', () => {
  const layers = defaultPCBDisplay(),
    filters = defaultPCBSelectionFilters();
  const board: PCB = {
    ...createEmptyPCB(),
    tracks: [
      {
        id: 'track',
        layer: 'F.Cu',
        netId: 'n',
        width: 0.2,
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
      },
    ],
  };
  const owned = ownProjectData(board),
    at = { x: 5, y: 0 };
  const result = selectPCBPoint(owned, layers, filters, at, 0);
  assert.equal(result[0].id, 'track');
  result[0].id = 'caller-mutation';
  assert.equal(selectPCBPoint(owned, layers, filters, at, 0)[0].id, 'track');
  const frozen = Object.freeze(structuredClone(board));
  assert.equal(selectPCBPoint(frozen, layers, filters, at, 0).length, 1);
  frozen.tracks[0].start.y = frozen.tracks[0].end.y = 20;
  assert.deepEqual(selectPCBPoint(frozen, layers, filters, at, 0), []);
  const preview = movePCBSelection(owned, [{ kind: 'track', id: 'track' }], { x: 0, y: 5 });
  assert.deepEqual(selectPCBPoint(preview, layers, filters, at, 0), []);
  assert.equal(selectPCBPoint(preview, layers, filters, { x: 5, y: 5 }, 0).length, 1);
  preview.tracks[0].start.y = preview.tracks[0].end.y = 9;
  assert.deepEqual(selectPCBPoint(preview, layers, filters, { x: 5, y: 5 }, 0), []);
  assert.equal(selectPCBPoint(owned, layers, filters, at, 0).length, 1);
  layers['F.Cu'] = false;
  assert.deepEqual(selectPCBPoint(owned, layers, filters, at, 0), []);
  layers['F.Cu'] = true;
  assert.equal(selectPCBPoint(owned, layers, filters, at, 0).length, 1);
});

test('saved-fill queries always read current caller maps and retain precise DOM order', () => {
  const zone = {
    id: 'zone',
    layer: 'F.Cu' as const,
    netId: 'n',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    clearance: 0.2,
    minThickness: 0.2,
    thermalGap: 0.2,
    thermalBridge: 0.2,
  };
  const board = ownProjectData({ ...createEmptyPCB(), zones: [zone] });
  const layers = { ...defaultPCBDisplay(), zoneOutlines: false },
    filters = defaultPCBSelectionFilters();
  const preparedFills = new Map([[zone.id, [{ outer: zone.outline, holes: [] }]]]);
  const options: PCBPointSelectionOptions = { preparedFills };
  for (const includeFills of [false, true]) {
    options.includeFills = includeFills;
    assert.equal(selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, 0, options)[0].id, 'zone');
    preparedFills.clear();
    assert.deepEqual(selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, 0, options), []);
    preparedFills.set(zone.id, [{ outer: zone.outline, holes: [] }]);
  }
  const withTracks = ownProjectData({
    ...board,
    tracks: [
      {
        id: 'first',
        layer: 'F.Cu' as const,
        netId: 'n',
        width: 0.2,
        start: { x: 0, y: 2 },
        end: { x: 10, y: 2 },
      },
      {
        id: 'second',
        layer: 'F.Cu' as const,
        netId: 'n',
        width: 0.2,
        start: { x: 0, y: 2 },
        end: { x: 10, y: 2 },
      },
    ],
  });
  assert.deepEqual(
    selectPCBPoint(withTracks, layers, filters, { x: 2, y: 2 }, 0, {
      preparedFills,
      preciseCandidates: [{ kind: 'track', id: 'second' }],
    }).map((item) => item.id),
    ['second', 'first'],
  );
});
