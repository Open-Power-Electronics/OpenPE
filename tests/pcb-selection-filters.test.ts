import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardLine, BoardZone, PCB } from '../lib/pcb';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { createEmptyPCB, type PCBSelection } from '../lib/pcb-layout';
import {
  defaultPCBSelectionFilters,
  pcbPointZoneOutlineHits,
  pcbSelectionEligible,
  selectPCBPoint,
  selectPCBRectangle,
  type PCBSelectionFilters,
} from '../lib/pcb-selection';
import { expandPCBTrackSelection } from '../lib/pcb-track-selection';

const zone = (id: string, x: number, keepout = false): BoardZone => ({
  id,
  netId: null,
  layer: 'F.Cu',
  outline: [
    { x, y: 0 },
    { x: x + 8, y: 0 },
    { x: x + 8, y: 8 },
    { x, y: 8 },
  ],
  clearance: 0.2,
  minThickness: 0.2,
  thermalGap: 0.2,
  thermalBridge: 0.2,
  ...(keepout && {
    keepout: { tracks: true, vias: true, pads: true, copperpour: true, footprints: false },
  }),
});
const text = { value: 'Test', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 };
const dimension: BoardLine = {
  id: 'dimension',
  kind: 'dimension',
  layer: 'F.Fab',
  start: { x: 12, y: 2 },
  end: { x: 16, y: 2 },
  width: 0.1,
  dimension: {
    type: 'aligned',
    height: 2,
    format: { prefix: '', suffix: '', units: 2, unitsFormat: 0, precision: 2 },
    style: { arrowLength: 1, textPositionMode: 0, extensionOffset: 0 },
    caption: { ...text, x: 14, y: 4 },
  },
};
const fixture = (): PCB => ({
  ...createEmptyPCB(),
  graphics: [
    {
      id: 'text',
      kind: 'text',
      layer: 'F.SilkS',
      start: { x: 2, y: 2 },
      end: { x: 2, y: 2 },
      width: 0.1,
      text,
    },
    dimension,
    {
      id: 'graphic',
      layer: 'F.SilkS',
      start: { x: 24, y: 2 },
      end: { x: 28, y: 2 },
      width: 0.1,
    },
  ],
  zones: [zone('copper', 40), zone('rule-area', 55, true)],
  tracks: [
    {
      id: 'locked',
      start: { x: 70, y: 0 },
      end: { x: 74, y: 0 },
      width: 0.2,
      layer: 'F.Cu',
      netId: 'n',
      locked: true,
    },
    {
      id: 'unlocked',
      start: { x: 70, y: 6 },
      end: { x: 74, y: 6 },
      width: 0.2,
      layer: 'F.Cu',
      netId: 'n',
    },
  ],
});
const ids = (selection: PCBSelection[]) => selection.map((item) => item.id);
const allIds = ['locked', 'unlocked', 'text', 'dimension', 'graphic', 'copper', 'rule-area'];

test('independent filter categories agree across complete windows, point geometry and DOM candidates', () => {
  const board = fixture(),
    before = structuredClone(board),
    layers = defaultPCBDisplay();
  const cases = [
    ['text', 'text', { kind: 'graphic', id: 'text' }, { x: 2, y: 2 }],
    ['dimension', 'dimension', { kind: 'graphic', id: 'dimension' }, { x: 12, y: 2 }],
    ['graphic', 'graphic', { kind: 'graphic', id: 'graphic' }, { x: 24, y: 2 }],
    ['zone', 'copper', { kind: 'zone', id: 'copper' }, { x: 40, y: 4 }],
    ['ruleArea', 'rule-area', { kind: 'zone', id: 'rule-area' }, { x: 55, y: 4 }],
    ['locked', 'locked', { kind: 'track', id: 'locked' }, { x: 72, y: 0 }],
  ] as const;
  assert.deepEqual(
    ids(
      selectPCBRectangle(
        board,
        layers,
        defaultPCBSelectionFilters(),
        { x: -5, y: -5 },
        { x: 80, y: 20 },
      ),
    ),
    allIds.filter((id) => id !== 'locked'),
  );
  for (const [key, id, selection, at] of cases) {
    const enabled = { ...defaultPCBSelectionFilters(), locked: true },
      disabled = { ...enabled, [key]: false };
    assert.equal(pcbSelectionEligible(board, selection, enabled), true);
    assert.equal(pcbSelectionEligible(board, selection, disabled), false);
    assert.deepEqual(
      ids(selectPCBRectangle(board, layers, disabled, { x: -5, y: -5 }, { x: 80, y: 20 })),
      allIds.filter((candidate) => candidate !== id),
    );
    assert.deepEqual(ids(selectPCBPoint(board, layers, enabled, at, 0.01)), [id]);
    assert.deepEqual(ids(selectPCBPoint(board, layers, disabled, at, 0.01)), []);
    assert.deepEqual(
      ids(
        selectPCBPoint(board, layers, disabled, { x: 100, y: 100 }, 0, {
          preciseCandidates: [selection],
        }),
      ),
      [],
    );
  }
  assert.deepEqual(board, before);
});

test('legacy combined filters and missing IDs retain bounded eligibility', () => {
  const board = fixture(),
    legacy: PCBSelectionFilters = {
      footprint: true,
      track: true,
      via: true,
      graphic: false,
      zone: false,
    };
  assert.deepEqual(
    ids(selectPCBRectangle(board, defaultPCBDisplay(), legacy, { x: -5, y: -5 }, { x: 80, y: 20 })),
    ['locked', 'unlocked'],
  );
  for (const kind of ['footprint', 'track', 'via', 'graphic', 'zone'] as const)
    assert.equal(pcbSelectionEligible(board, { kind, id: 'missing' }, legacy), false);
  const first = defaultPCBSelectionFilters(),
    second = defaultPCBSelectionFilters();
  first.text = false;
  assert.equal(second.text, true);
});

test('rule-area and copper filters gate saved fills and embedded outline hits without disabling footprint bodies', () => {
  const copper = zone('copper', 0),
    rule = zone('rule-area', 20, true),
    board = { ...createEmptyPCB(), zones: [copper, rule] },
    filters = defaultPCBSelectionFilters(),
    layers = defaultPCBDisplay(),
    fills = new Map([
      [copper.id, [{ outer: copper.outline, holes: [] }]],
      [rule.id, [{ outer: rule.outline, holes: [] }]],
    ]),
    before = structuredClone(board);
  layers.zoneOutlines = false;
  for (const [key, at] of [
    ['zone', { x: 4, y: 4 }],
    ['ruleArea', { x: 24, y: 4 }],
  ] as const) {
    assert.equal(selectPCBPoint(board, layers, filters, at, 0, { preparedFills: fills }).length, 1);
    assert.deepEqual(
      selectPCBPoint(board, layers, { ...filters, [key]: false }, at, 0, { preparedFills: fills }),
      [],
    );
  }
  const embedded: PCB = {
    ...createEmptyPCB(),
    footprints: [
      {
        id: 'owner',
        libraryId: 'Test:Filter',
        symbolId: null,
        x: 0,
        y: 0,
        rotation: 0,
        side: 'front',
        graphics: [],
        zones: [rule],
        pads: [
          {
            id: 'pad',
            number: '1',
            x: 0,
            y: 0,
            rotation: 0,
            type: 'smd',
            shape: 'rect',
            size: { x: 2, y: 2 },
            netId: null,
          },
        ],
      },
    ],
  };
  layers.zoneOutlines = true;
  const noRules = { ...filters, ruleArea: false };
  assert.deepEqual([...pcbPointZoneOutlineHits(embedded, layers, { x: 20, y: 4 }, 0, noRules)], []);
  assert.deepEqual(ids(selectPCBPoint(embedded, layers, noRules, { x: 20, y: 4 }, 0)), []);
  assert.deepEqual(ids(selectPCBPoint(embedded, layers, noRules, { x: 0, y: 0 }, 0)), ['owner']);
  assert.deepEqual(board, before);
});

test('locked-item filtering excludes locked seeds and cannot traverse locked copper during expansion', () => {
  const board = createEmptyPCB(),
    layers = defaultPCBDisplay(),
    filters = defaultPCBSelectionFilters();
  board.tracks = [0, 1, 2].map((i) => ({
    id: String(i),
    start: { x: i * 2, y: 0 },
    end: { x: i * 2 + 2, y: 0 },
    width: 0.2,
    layer: 'F.Cu',
    netId: 'n',
    ...(i === 1 ? { locked: true as const } : {}),
  }));
  const before = structuredClone(board),
    seed: PCBSelection[] = [{ kind: 'track', id: '0' }];
  for (const mode of ['chain', 'connected'] as const) {
    assert.deepEqual(
      ids(expandPCBTrackSelection(board, seed, layers, { ...filters, locked: true }, mode)),
      ['0', '1', '2'],
    );
    assert.deepEqual(ids(expandPCBTrackSelection(board, seed, layers, filters, mode)), ['0']);
    assert.deepEqual(
      expandPCBTrackSelection(board, [{ kind: 'track', id: '1' }], layers, filters, mode),
      [],
    );
  }
  assert.deepEqual(board, before);
});
