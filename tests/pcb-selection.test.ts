import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Footprint, PCB } from '../lib/pcb';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { createEmptyPCB, flipPCBFootprint, padPosition } from '../lib/pcb-layout';
import { copperFillContour, type Polygon } from '../lib/pcb-polygons';
import {
  choosePCBPointCandidate,
  mergePCBSelection,
  pcbPointZoneOutlineHits,
  selectPCBPoint,
  selectPCBRectangle,
  type PCBSelectionFilters,
} from '../lib/pcb-selection';

const filters: PCBSelectionFilters = {
  footprint: true,
  track: true,
  via: true,
  graphic: true,
  zone: true,
};
const footprint = (id: string, x = 0, y = 0): Footprint => ({
  id,
  x,
  y,
  libraryId: 'Test:Selection',
  symbolId: null,
  rotation: 0,
  side: 'front',
  pads: [
    {
      id: `${id}-pad`,
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      size: { x: 2, y: 2 },
      type: 'smd',
      shape: 'rect',
      netId: null,
    },
  ],
  graphics: [],
});
const ids = (selection: ReturnType<typeof selectPCBRectangle>) => selection.map((item) => item.id);

test('physical paint order resolves exact copper ties independently of record and candidate order', () => {
  const board = createEmptyPCB();
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  const layers = defaultPCBDisplay();
  const layerOrder = Object.freeze(['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu']);
  const tracks: PCB['tracks'] = [
    {
      id: 'a-back',
      layer: 'B.Cu',
      start: { x: -2, y: 0 },
      end: { x: 2, y: 0 },
      width: 0.4,
      netId: 'n',
    },
    {
      id: 'z-front',
      layer: 'F.Cu',
      start: { x: 0, y: -2 },
      end: { x: 0, y: 2 },
      width: 0.4,
      netId: 'n',
    },
    {
      id: 'b-inner2',
      layer: 'In2.Cu',
      start: { x: -2, y: 0 },
      end: { x: 2, y: 0 },
      width: 0.4,
      netId: 'n',
    },
    {
      id: 'y-inner1',
      layer: 'In1.Cu',
      start: { x: 0, y: -2 },
      end: { x: 0, y: 2 },
      width: 0.4,
      netId: 'n',
    },
  ];
  const beforeLayers = structuredClone(layers);
  for (const ordered of [tracks, tracks.toReversed()]) {
    const current = { ...board, tracks: ordered };
    const beforeBoard = structuredClone(current);
    const candidates = ordered.map(({ id }) => ({ selection: { kind: 'track' as const, id } }));
    for (const list of [candidates, candidates.toReversed()]) {
      const pick = (priorityLayer?: string) =>
        choosePCBPointCandidate(
          current,
          layers,
          list,
          { x: 0, y: 0 },
          {
            tolerance: 0,
            layerOrder,
            priorityLayer,
          },
        )?.selection.id;
      assert.equal(pick(), 'z-front');
      assert.equal(pick('B.Cu'), 'a-back', 'Explicit display priority still wins an exact tie.');
      const inner = list.filter(({ selection }) => selection.id.includes('inner'));
      assert.equal(
        choosePCBPointCandidate(
          current,
          layers,
          inner,
          { x: 0, y: 0 },
          { tolerance: 0, layerOrder },
        )?.selection.id,
        'y-inner1',
        'The upper inner copper layer wins without depending on native record order.',
      );
      assert.equal(
        choosePCBPointCandidate(current, layers, list, { x: 0, y: 0 }, { tolerance: 0 })?.selection
          .id,
        'a-back',
        'Callers without a paint order keep the previous deterministic tie behavior.',
      );
    }
    assert.deepEqual(current, beforeBoard);
  }
  assert.deepEqual(layers, beforeLayers);
  assert.deepEqual(layerOrder, ['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu']);
});

test('physical tie ranking excludes hidden copper while retaining the nearest visible geometry', () => {
  const board = createEmptyPCB();
  board.tracks = [
    {
      id: 'back',
      layer: 'B.Cu',
      start: { x: -2, y: 0 },
      end: { x: 2, y: 0 },
      width: 0.2,
      netId: 'n',
    },
    {
      id: 'front',
      layer: 'F.Cu',
      start: { x: -2, y: 0.1 },
      end: { x: 2, y: 0.1 },
      width: 0.2,
      netId: 'n',
    },
  ];
  const layers = defaultPCBDisplay();
  const candidates = board.tracks.map(({ id }) => ({ selection: { kind: 'track' as const, id } }));
  const options = {
    tolerance: 0.5,
    tieTolerance: 0.01,
    layerOrder: ['B.Cu', 'F.Cu'],
    priorityLayer: 'F.Cu',
  };
  const pick = () =>
    choosePCBPointCandidate(board, layers, candidates, { x: 0, y: 0 }, options)?.selection.id;
  assert.equal(
    pick(),
    'back',
    'A nearer centreline wins before either display priority or paint order.',
  );
  board.tracks[1] = { ...board.tracks[1], start: { x: -2, y: 0.4 }, end: { x: 2, y: 0.4 } };
  assert.equal(pick(), 'back', 'A nearer surface wins before paint order.');
  layers['B.Cu'] = false;
  assert.equal(pick(), 'front', 'A hidden lower layer is excluded before scoring.');
  layers['F.Cu'] = false;
  assert.equal(pick(), undefined);
});

test('shared pads rank at their highest visible paint layer and mechanical holes use Edge.Cuts', () => {
  const through = footprint('through');
  through.pads[0] = {
    ...through.pads[0],
    id: 'z-through-pad',
    type: 'thru_hole',
    drill: 0.6,
    layers: ['*.Cu'],
  };
  const back = { ...footprint('back'), side: 'back' as const };
  back.pads[0] = { ...back.pads[0], id: 'a-back-pad', layers: ['B.Cu'] };
  const board = { ...createEmptyPCB(), footprints: [through, back] };
  const layers = defaultPCBDisplay();
  const candidates = [{ padId: 'a-back-pad' }, { padId: 'z-through-pad' }];
  const options = {
    tolerance: 0,
    layerOrder: ['B.Cu', 'F.Cu', 'Edge.Cuts'],
    filters: { ...filters, pad: true },
  };
  const beforeBoard = structuredClone(board);
  const pick = () =>
    choosePCBPointCandidate(board, layers, candidates, { x: 0, y: 0 }, options)?.padId;
  assert.equal(pick(), 'z-through-pad', 'Shared through copper is visible in the top copper pass.');
  layers['F.Cu'] = false;
  assert.equal(
    pick(),
    'a-back-pad',
    'A hidden front layer cannot raise a shared pad above the visible back tie.',
  );
  const hole = footprint('hole');
  hole.pads[0] = { ...hole.pads[0], id: 'mechanical-hole', type: 'np_thru_hole', drill: 2 };
  board.footprints.push(hole);
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      [...candidates, { padId: 'mechanical-hole' }],
      { x: 0, y: 0 },
      options,
    )?.padId,
    'mechanical-hole',
  );
  board.footprints.pop();
  assert.deepEqual(board, beforeBoard);
});

test('active-layer rectangles select only visible geometry on that layer, including shared through copper', () => {
  const board = createEmptyPCB();
  const layers = defaultPCBDisplay();
  const before = structuredClone(layers);
  board.tracks = ['F.Cu', 'B.Cu'].map((layer) => ({
    id: layer,
    layer: layer as 'F.Cu' | 'B.Cu',
    netId: 'net',
    width: 0.4,
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
  }));
  board.vias = [{ id: 'via', x: 2, y: 0, diameter: 1, drill: 0.3, netId: 'net' }];
  board.graphics = [
    { id: 'silk', layer: 'F.SilkS', width: 0.2, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
  ];
  const select = (layer: 'F.Cu' | 'B.Cu' | 'F.SilkS', crossing = false) =>
    ids(
      selectPCBRectangle(
        board,
        layers,
        filters,
        { x: crossing ? 6 : -1, y: -1 },
        { x: crossing ? -1 : 6, y: 1 },
        undefined,
        layer,
      ),
    );
  for (const crossing of [false, true]) {
    assert.deepEqual(select('F.Cu', crossing), ['F.Cu', 'via']);
    assert.deepEqual(select('B.Cu', crossing), ['B.Cu', 'via']);
    assert.deepEqual(select('F.SilkS', crossing), ['silk']);
  }
  assert.deepEqual(layers, before, 'Layer selection never rewrites the visibility preferences.');
  layers['B.Cu'] = false;
  assert.deepEqual(select('B.Cu'), [], 'A hidden active layer cannot expose selectable geometry.');
});

test('active-layer footprint windows exclude other-layer pads, courtyards and distant artwork', () => {
  const part = footprint('front');
  part.graphics = [
    {
      id: 'courtyard',
      layer: 'F.CrtYd',
      width: 0.1,
      start: { x: -20, y: -20 },
      end: { x: 20, y: 20 },
    },
  ];
  const back = { ...footprint('back', 5, 0), side: 'back' as const };
  const through = {
    ...footprint('through', 10, 0),
    pads: [
      {
        ...footprint('through').pads[0],
        type: 'thru_hole' as const,
        drill: 0.4,
      },
    ],
  };
  const board = { ...createEmptyPCB(), footprints: [part, back, through] };
  const layers = defaultPCBDisplay();
  const select = (layer: 'F.Cu' | 'B.Cu' | 'F.CrtYd') =>
    ids(
      selectPCBRectangle(
        board,
        layers,
        filters,
        { x: -2, y: -2 },
        { x: 12, y: 2 },
        undefined,
        layer,
      ),
    );
  assert.deepEqual(select('F.Cu'), ['front', 'through']);
  assert.deepEqual(select('B.Cu'), ['back', 'through']);
  assert.deepEqual(select('F.CrtYd'), []);
});

test('left-to-right contains complete visible bodies; right-to-left touches them without mutating the board', () => {
  const board = { ...createEmptyPCB(), footprints: [footprint('part')] },
    before = structuredClone(board),
    layers = defaultPCBDisplay();
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 0, y: -2 }, { x: 2, y: 2 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 2, y: -2 }, { x: 0, y: 2 })),
    ['part'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: -1, y: -1 }, { x: 1, y: 1 })),
    ['part'],
  );
  assert.deepEqual(board, before);
});

test('rotated and flipped footprint selection follows its local body rather than empty world bounding corners', () => {
  const part = {
    ...footprint('rotated'),
    rotation: 45,
    pads: [{ ...footprint('rotated').pads[0], x: 2, size: { x: 8, y: 0.5 } }],
  };
  for (const candidate of [part, flipPCBFootprint(part)]) {
    const board = { ...createEmptyPCB(), footprints: [candidate] },
      center = padPosition(candidate, candidate.pads[0]);
    assert.deepEqual(
      ids(
        selectPCBRectangle(board, defaultPCBDisplay(), filters, { x: 4, y: 0 }, { x: 3.5, y: 0.5 }),
      ),
      [],
    );
    assert.deepEqual(
      ids(
        selectPCBRectangle(
          board,
          defaultPCBDisplay(),
          filters,
          { x: center.x + 0.2, y: center.y - 0.2 },
          { x: center.x - 0.2, y: center.y + 0.2 },
        ),
      ),
      ['rotated'],
    );
  }
});

test('distant captions, dimensions, hidden pads and the footprint origin never expand its body', () => {
  const part: Footprint = {
      ...footprint('part', 20, 20),
      pads: [
        { ...footprint('part').pads[0], x: 8 },
        { ...footprint('part').pads[0], id: 'hidden', x: -8, layers: ['B.Cu'] },
      ],
      graphics: [
        {
          id: 'caption',
          kind: 'text',
          layer: 'F.SilkS',
          start: { x: -20, y: 0 },
          end: { x: -20, y: 0 },
          width: 0.1,
          text: { value: 'A distant reference', size: { x: 1, y: 1 }, rotation: 0, thickness: 0.1 },
        },
        {
          id: 'dimension',
          kind: 'dimension',
          layer: 'F.Fab',
          start: { x: -15, y: -15 },
          end: { x: 15, y: 15 },
          width: 0.1,
        },
      ],
    },
    board = { ...createEmptyPCB(), footprints: [part] },
    layers = defaultPCBDisplay();
  layers['B.Cu'] = false;
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 26.5, y: 18.5 }, { x: 29.5, y: 21.5 })),
    ['part'],
  );
  for (const x of [0, 12, 20])
    assert.deepEqual(
      ids(
        selectPCBRectangle(
          board,
          layers,
          filters,
          { x: x + 0.5, y: 19.5 },
          { x: x - 0.5, y: 20.5 },
        ),
      ),
      [],
    );
});

test('crossing uses track capsules and via circles, excluding empty diagonal bounding-box corners', () => {
  const board: PCB = {
      ...createEmptyPCB(),
      tracks: [
        {
          id: 'diagonal',
          start: { x: 0, y: 0 },
          end: { x: 10, y: 10 },
          width: 0.4,
          layer: 'F.Cu',
          netId: 'n',
        },
      ],
      vias: [{ id: 'via', x: 20, y: 20, diameter: 2, drill: 0.5, netId: 'n' }],
    },
    layers = defaultPCBDisplay();
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 9, y: 1 }, { x: 8, y: 2 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 5.3, y: 4.8 }, { x: 5.2, y: 5.1 })),
    ['diagonal'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 21.2, y: 20.8 }, { x: 20.8, y: 21.2 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 21.1, y: 19.9 }, { x: 20.9, y: 20.1 })),
    ['via'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: -0.1, y: -0.1 }, { x: 10.1, y: 10.1 })),
    [],
  );
});

test('filters and visible layer controls exclude hidden objects while retaining visible board edges', () => {
  const board: PCB = {
      ...createEmptyPCB(),
      footprints: [footprint('part')],
      tracks: [
        {
          id: 'track',
          start: { x: 0, y: 0 },
          end: { x: 1, y: 0 },
          width: 0.2,
          layer: 'B.Cu',
          netId: 'n',
        },
      ],
      vias: [{ id: 'via', x: 0, y: 0, diameter: 0.8, drill: 0.4, netId: 'n' }],
      graphics: [
        { id: 'edge', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 0.1, layer: 'Edge.Cuts' },
        { id: 'silk', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 0.1, layer: 'F.SilkS' },
      ],
    },
    layers = { ...defaultPCBDisplay(), 'B.Cu': false },
    a = { x: -2, y: -2 },
    b = { x: 2, y: 2 };
  assert.deepEqual(ids(selectPCBRectangle(board, layers, { ...filters, footprint: false }, a, b)), [
    'via',
    'edge',
    'silk',
  ]);
  layers.footprints = false;
  layers['F.Cu'] = false;
  assert.deepEqual(ids(selectPCBRectangle(board, layers, filters, a, b)), ['edge']);
});

test('crossing artwork respects hollow circles and actual polygon edges instead of their bounding boxes', () => {
  const board: PCB = {
      ...createEmptyPCB(),
      graphics: [
        {
          id: 'circle',
          kind: 'circle',
          start: { x: 0, y: 0 },
          end: { x: 5, y: 0 },
          width: 0.2,
          layer: 'F.SilkS',
        },
        {
          id: 'triangle',
          kind: 'polygon',
          start: { x: 20, y: 0 },
          end: { x: 20, y: 10 },
          points: [{ x: 30, y: 10 }],
          width: 0.1,
          layer: 'F.SilkS',
          fill: true,
        },
      ],
    },
    layers = defaultPCBDisplay();
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 1, y: -1 }, { x: -1, y: 1 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 5.1, y: -0.2 }, { x: 4.9, y: 0.2 })),
    ['circle'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 29, y: 1 }, { x: 28, y: 2 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 21, y: 8 }, { x: 20.5, y: 9 })),
    ['triangle'],
  );
});

test('zone selection respects outline visibility and saved copper holes', () => {
  const board: PCB = {
      ...createEmptyPCB(),
      zones: [
        {
          id: 'zone',
          netId: 'n',
          layer: 'F.Cu',
          outline: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
          holes: [
            [
              { x: 4, y: 4 },
              { x: 6, y: 4 },
              { x: 6, y: 6 },
              { x: 4, y: 6 },
            ],
          ],
          clearance: 0.25,
          minThickness: 0.2,
          thermalGap: 0.3,
          thermalBridge: 0.3,
          filledPolygons: [
            {
              points: copperFillContour({
                outer: [
                  { x: 0, y: 0 },
                  { x: 10, y: 0 },
                  { x: 10, y: 10 },
                  { x: 0, y: 10 },
                ],
                holes: [
                  [
                    { x: 4, y: 4 },
                    { x: 6, y: 4 },
                    { x: 6, y: 6 },
                    { x: 4, y: 6 },
                  ],
                ],
              }),
            },
          ],
        },
      ],
    },
    layers = defaultPCBDisplay();
  layers.zoneOutlines = false;
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 5.5, y: 4.5 }, { x: 4.5, y: 5.5 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 2, y: 1 }, { x: 1, y: 2 })),
    ['zone'],
  );
  layers.copper = false;
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 2, y: 1 }, { x: 1, y: 2 })),
    [],
  );
  layers.zoneOutlines = true;
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 0.2, y: 1 }, { x: -0.2, y: 2 })),
    ['zone'],
  );
});

test('arc selection excludes the unused circle sweep and hidden text has no rectangle target', () => {
  const board: PCB = {
      ...createEmptyPCB(),
      graphics: [
        {
          id: 'arc',
          kind: 'arc',
          start: { x: 0, y: 0 },
          mid: { x: 5, y: 5 },
          end: { x: 10, y: 0 },
          width: 0.2,
          layer: 'F.SilkS',
        },
        {
          id: 'hidden',
          kind: 'text',
          start: { x: 20, y: 20 },
          end: { x: 20, y: 20 },
          width: 0.1,
          layer: 'F.SilkS',
          text: {
            value: 'Hidden',
            rotation: 0,
            size: { x: 1, y: 1 },
            thickness: 0.1,
            hidden: true,
          },
        },
      ],
    },
    layers = defaultPCBDisplay();
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 6, y: -5.2 }, { x: 4, y: -4.8 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 6, y: 4.8 }, { x: 4, y: 5.2 })),
    ['arc'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: -0.2, y: -0.2 }, { x: 10.2, y: 5.2 })),
    ['arc'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 15, y: 15 }, { x: 25, y: 25 })),
    [],
  );
});

test('selection merge is stable and handles additive, toggle and subtract gestures atomically', () => {
  const a = { kind: 'footprint', id: 'a' } as const,
    b = { kind: 'track', id: 'b' } as const,
    c = { kind: 'via', id: 'c' } as const,
    current = [a, b],
    incoming = [b, c, c];
  assert.deepEqual(mergePCBSelection(current, incoming), [b, c]);
  assert.deepEqual(mergePCBSelection(current, incoming, 'add'), [a, b, c]);
  assert.deepEqual(mergePCBSelection(current, incoming, 'toggle'), [a, c]);
  assert.deepEqual(mergePCBSelection(current, incoming, 'subtract'), [a]);
  assert.deepEqual(current, [a, b]);
  assert.deepEqual(incoming, [b, c, c]);
});

const selectionZone = (): PCB['zones'][number] => ({
  id: 'zone',
  netId: null,
  layer: 'F.Cu',
  outline: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  holes: [
    [
      { x: 4, y: 4 },
      { x: 6, y: 4 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
    ],
  ],
  clearance: 0.25,
  minThickness: 0.2,
  thermalGap: 0.3,
  thermalBridge: 0.3,
});

test('point zone boundaries include closing edges, holes and their stroke without targeting fill interiors', () => {
  const zone = selectionZone(),
    board = { ...createEmptyPCB(), zones: [zone] },
    layers = defaultPCBDisplay();
  zone.filledPolygons = [
    { points: copperFillContour({ outer: zone.outline, holes: zone.holes! }) },
  ];
  const before = structuredClone(board);
  for (const point of [
    { x: 0, y: 5 },
    { x: 4, y: 5 },
    { x: -0.239, y: 5 },
  ])
    assert.deepEqual([...pcbPointZoneOutlineHits(board, layers, point, 0.2)], ['zone']);
  for (const point of [
    { x: 2, y: 2 },
    { x: 5, y: 5 },
    { x: -0.241, y: 5 },
  ])
    assert.deepEqual([...pcbPointZoneOutlineHits(board, layers, point, 0.2)], []);
  assert.deepEqual(
    [...pcbPointZoneOutlineHits(board, { ...layers, copper: false }, { x: 0, y: 5 }, 0)],
    ['zone'],
  );
  for (const hidden of [
    { ...layers, zoneOutlines: false },
    { ...layers, 'F.Cu': false },
  ])
    assert.deepEqual([...pcbPointZoneOutlineHits(board, hidden, { x: 0, y: 5 }, 1)], []);
  assert.deepEqual([...pcbPointZoneOutlineHits(board, layers, { x: 0, y: 5 }, -1)], []);
  assert.deepEqual([...pcbPointZoneOutlineHits(board, layers, { x: NaN, y: 5 }, 1)], []);
  assert.deepEqual(board, before);
});

test('embedded zone-only footprints have transformed outline and saved fill selection targets owned by the footprint', () => {
  const zone = selectionZone(),
    part = { ...footprint('owner', 20, 20), rotation: 90, pads: [], zones: [zone] },
    board = { ...createEmptyPCB(), footprints: [part] },
    layers = defaultPCBDisplay();
  // Rotation maps the local left edge to the horizontal world edge at y = 20.
  assert.deepEqual([...pcbPointZoneOutlineHits(board, layers, { x: 25, y: 20 }, 0)], ['zone']);
  assert.deepEqual(
    [...pcbPointZoneOutlineHits(board, { ...layers, footprints: false }, { x: 25, y: 20 }, 1)],
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 25.2, y: 19.9 }, { x: 24.8, y: 20.1 })),
    ['owner'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 19, y: 9 }, { x: 31, y: 21 })),
    ['owner'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 24, y: 9 }, { x: 31, y: 21 })),
    [],
  );
  layers.zoneOutlines = false;
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 22.2, y: 17.8 }, { x: 21.8, y: 18.2 })),
    [],
  );
  zone.filledPolygons = [
    { points: copperFillContour({ outer: zone.outline, holes: zone.holes! }) },
  ];
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 22.2, y: 17.8 }, { x: 21.8, y: 18.2 })),
    ['owner'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 25.2, y: 14.8 }, { x: 24.8, y: 15.2 })),
    [],
  );
  layers.copper = false;
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: 22.2, y: 17.8 }, { x: 21.8, y: 18.2 })),
    [],
  );
});

test('contained footprint selection includes its remote embedded zone geometry', () => {
  const part = { ...footprint('owner'), zones: [selectionZone()] },
    board = { ...createEmptyPCB(), footprints: [part] },
    layers = defaultPCBDisplay();
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: -2, y: -2 }, { x: 2, y: 2 })),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: -2, y: -2 }, { x: 11, y: 11 })),
    ['owner'],
  );
  layers.zoneOutlines = false;
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, { x: -2, y: -2 }, { x: 2, y: 2 })),
    ['owner'],
  );
});

test('prepared visible fills are reused with holes and an empty map suppresses native fill recomputation', () => {
  const zone = selectionZone(),
    board = { ...createEmptyPCB(), zones: [zone] },
    layers = { ...defaultPCBDisplay(), zoneOutlines: false };
  zone.filledPolygons = [{ points: zone.outline }];
  const preparedFills = new Map([[zone.id, [{ outer: zone.outline, holes: zone.holes! }]]]),
    beforeBoard = structuredClone(board),
    beforeFills = structuredClone(preparedFills),
    holeStart = { x: 5.2, y: 4.8 },
    holeEnd = { x: 4.8, y: 5.2 },
    fillStart = { x: 2.2, y: 1.8 },
    fillEnd = { x: 1.8, y: 2.2 };
  assert.deepEqual(ids(selectPCBRectangle(board, layers, filters, holeStart, holeEnd)), ['zone']);
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, holeStart, holeEnd, preparedFills)),
    [],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, fillStart, fillEnd, preparedFills)),
    ['zone'],
  );
  assert.deepEqual(
    ids(selectPCBRectangle(board, layers, filters, fillStart, fillEnd, new Map())),
    [],
  );
  assert.deepEqual(board, beforeBoard);
  assert.deepEqual(preparedFills, beforeFills);
});

test('ordinary point selection skips all prepared fills on precise geometry, DOM captions and pad inspection', () => {
  class ReadTrackingFills extends Map<string, Polygon[]> {
    reads = 0;
    override get(key: string) {
      this.reads++;
      return super.get(key);
    }
  }
  const zone = selectionZone(),
    board: PCB = {
      ...createEmptyPCB(),
      zones: [zone],
      footprints: [footprint('part', 8, 8)],
      tracks: [
        {
          id: 'track',
          start: { x: 1, y: 2 },
          end: { x: 9, y: 2 },
          width: 0.2,
          layer: 'F.Cu',
          netId: 'n',
        },
      ],
    },
    layers = defaultPCBDisplay(),
    preparedFills = new ReadTrackingFills([
      [zone.id, [{ outer: zone.outline, holes: zone.holes! }]],
    ]);
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, 0.1, { preparedFills })),
    ['track'],
  );
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 8, y: 8 }, 0.1, { preparedFills })),
    ['part'],
  );
  assert.deepEqual(
    ids(
      selectPCBPoint(board, layers, filters, { x: 2, y: 8 }, 0.1, {
        preparedFills,
        preciseCandidates: [{ kind: 'footprint', id: 'part' }],
      }),
    ),
    ['part'],
  );
  assert.deepEqual(
    ids(
      selectPCBPoint(board, layers, filters, { x: 2, y: 8 }, 0.1, {
        preparedFills,
        hasPrecisePad: true,
      }),
    ),
    [],
  );
  assert.equal(
    preparedFills.reads,
    0,
    'Precise ordinary hits never inspect prepared fill contours.',
  );
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 2, y: 8 }, 0.1, { preparedFills })),
    ['zone'],
  );
  assert.ok(preparedFills.reads > 0);
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 5, y: 5 }, 0.1, { preparedFills })),
    [],
  );
  assert.deepEqual(
    ids(
      selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, 0.1, {
        preparedFills,
        includeFills: true,
      }),
    ),
    ['track', 'zone'],
  );
});

test('point geometry retains complete overlap candidates and fill-inclusive queries match crossing selection', () => {
  const zone = selectionZone(),
    board: PCB = {
      ...createEmptyPCB(),
      zones: [zone],
      footprints: [footprint('part', 8, 8)],
      tracks: [
        {
          id: 'track',
          start: { x: 1, y: 2 },
          end: { x: 9, y: 2 },
          width: 0.2,
          layer: 'F.Cu',
          netId: 'n',
        },
      ],
      vias: [{ id: 'via', x: 3, y: 8, diameter: 1, drill: 0.4, netId: 'n' }],
    },
    layers = defaultPCBDisplay(),
    preparedFills = new Map([[zone.id, [{ outer: zone.outline, holes: zone.holes! }]]]),
    before = structuredClone(board);
  for (const at of [
    { x: 2, y: 2 },
    { x: 8, y: 8 },
    { x: 3, y: 8 },
    { x: 0, y: 5 },
    { x: 2, y: 8 },
    { x: 5, y: 5 },
    { x: 20, y: 20 },
  ]) {
    const start = { x: at.x + 0.1, y: at.y - 0.1 },
      end = { x: at.x - 0.1, y: at.y + 0.1 },
      precise = selectPCBRectangle(board, layers, filters, start, end, new Map()),
      full = selectPCBRectangle(board, layers, filters, start, end, preparedFills);
    assert.deepEqual(
      selectPCBPoint(board, layers, filters, at, 0.1, { preparedFills }),
      precise.length ? precise : full,
    );
    assert.deepEqual(
      selectPCBPoint(board, layers, filters, at, 0.1, { preparedFills, includeFills: true }),
      full,
    );
  }
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, 0, { preparedFills })),
    ['track'],
  );
  assert.deepEqual(selectPCBPoint(board, layers, filters, { x: NaN, y: 2 }, 0.1), []);
  assert.deepEqual(selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, -1), []);
  assert.deepEqual(board, before);
});

test('embedded fills are footprint-owned fallback targets and hidden footprints never become point candidates', () => {
  const zone = selectionZone(),
    part = { ...footprint('owner', 20, 20), pads: [], zones: [zone] },
    board: PCB = {
      ...createEmptyPCB(),
      footprints: [part],
      tracks: [
        {
          id: 'track',
          start: { x: 21, y: 22 },
          end: { x: 29, y: 22 },
          width: 0.2,
          layer: 'F.Cu',
          netId: 'n',
        },
      ],
    },
    layers = defaultPCBDisplay(),
    transform = (point: { x: number; y: number }) => ({ x: point.x + 20, y: point.y + 20 }),
    preparedFills = new Map([
      [
        zone.id,
        [
          {
            outer: zone.outline.map(transform),
            holes: zone.holes!.map((hole) => hole.map(transform)),
          },
        ],
      ],
    ]);
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 22, y: 22 }, 0.1, { preparedFills })),
    ['track'],
  );
  assert.deepEqual(
    ids(
      selectPCBPoint(board, layers, filters, { x: 22, y: 22 }, 0.1, {
        preparedFills,
        includeFills: true,
      }),
    ),
    ['owner', 'track'],
  );
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 22, y: 28 }, 0.1, { preparedFills })),
    ['owner'],
  );
  assert.deepEqual(
    ids(selectPCBPoint(board, layers, filters, { x: 25, y: 25 }, 0.1, { preparedFills })),
    [],
  );
  for (const includeFills of [false, true])
    assert.deepEqual(
      ids(
        selectPCBPoint(board, { ...layers, footprints: false }, filters, { x: 22, y: 28 }, 0.1, {
          preparedFills,
          includeFills,
          preciseCandidates: [{ kind: 'footprint', id: 'owner' }],
        }),
      ),
      [],
    );
  assert.deepEqual(
    ids(
      selectPCBPoint(board, layers, { ...filters, footprint: false }, { x: 22, y: 28 }, 0.1, {
        preparedFills,
      }),
    ),
    [],
  );
});
