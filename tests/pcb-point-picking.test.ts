import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Point } from '../lib/circuit';
import type { Footprint, PCB } from '../lib/pcb';
import {
  createEmptyPCB,
  findPCBGraphic,
  footprintPoint,
  movePCBSelection,
  replacePCBGraphic,
} from '../lib/pcb-layout';
import { defaultPCBDisplay, pcbDisplayForLayer } from '../lib/pcb-display';
import { parseProject } from '../lib/project';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import { ProjectCore } from '../core/project-core';
import {
  choosePCBPointCandidate,
  selectPCBPadPoint,
  selectPCBPoint,
  selectPCBRectangle,
  type PCBPointCandidate,
} from '../lib/pcb-selection';

const filters = { footprint: true, track: true, via: true, graphic: true, zone: true, pad: true };
const track = (id: string, start: Point, end: Point): PCB['tracks'][number] => ({
  id,
  start,
  end,
  width: 0.4,
  layer: 'F.Cu',
  netId: 'out',
});
const candidate = (kind: 'footprint' | 'track' | 'via' | 'graphic' | 'zone', id: string) => ({
  selection: { kind, id },
});
const owner = (): Footprint => ({
  id: 'part',
  libraryId: 'Test:Body',
  symbolId: null,
  x: 0,
  y: 0,
  side: 'front',
  rotation: 0,
  pads: [
    {
      id: 'pad',
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      size: { x: 1, y: 1 },
      shape: 'rect',
      type: 'smd',
      netId: 'out',
    },
  ],
  graphics: [
    {
      id: 'body',
      kind: 'polygon',
      layer: 'F.SilkS',
      width: 0.12,
      start: { x: -3, y: -2 },
      points: [
        { x: 3, y: -2 },
        { x: 3, y: 2 },
      ],
      end: { x: -3, y: 2 },
    },
  ],
});

test('direct picking follows either side of a shared track joint independently of candidate and source order', () => {
  const board = createEmptyPCB();
  board.tracks = [
    track('left', { x: -4, y: 0 }, { x: 0, y: 0 }),
    track('right', { x: 0, y: 0 }, { x: 4, y: 4 }),
  ];
  const candidates = board.tracks.map((item) => candidate('track', item.id));
  for (const items of [candidates, [...candidates].reverse()]) {
    for (const [at, expected] of [
      [{ x: -0.3, y: 0.05 }, 'left'],
      [{ x: 0.3, y: 0.3 }, 'right'],
    ] as const)
      assert.equal(
        choosePCBPointCandidate(board, defaultPCBDisplay(), items, at, { tolerance: 0.2, filters })
          ?.selection.id,
        expected,
      );
    board.tracks.reverse();
  }
});

test('crossing tracks use centreline distance when both visible strokes contain the pointer', () => {
  const board = createEmptyPCB();
  board.tracks = [
    track('horizontal', { x: -4, y: 0 }, { x: 4, y: 0 }),
    track('vertical', { x: 0, y: -4 }, { x: 0, y: 4 }),
  ];
  const candidates = board.tracks.map((item) => candidate('track', item.id));
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0.15, y: 0 },
      { tolerance: 0.2 },
    )?.selection.id,
    'horizontal',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0, y: 0.15 },
      { tolerance: 0.2 },
    )?.selection.id,
    'vertical',
  );
});

test('a broad footprint body never traps a track hit and real body ink remains selectable', () => {
  const part = owner(),
    board = {
      ...createEmptyPCB(),
      footprints: [part],
      tracks: [track('trace', { x: -6, y: 1 }, { x: 6, y: 1 })],
    };
  const candidates = [candidate('footprint', part.id), candidate('track', 'trace')],
    layers = defaultPCBDisplay();
  assert.equal(
    choosePCBPointCandidate(board, layers, candidates, { x: 0, y: 1 }, { tolerance: 0.2 })
      ?.selection.id,
    'trace',
  );
  assert.equal(
    choosePCBPointCandidate(board, layers, candidates, { x: 0, y: 1.98 }, { tolerance: 0.2 })
      ?.selection.id,
    part.id,
  );
  board.tracks[0] = { ...board.tracks[0], start: { x: -6, y: 0 }, end: { x: 6, y: 0 }, width: 4 };
  assert.equal(
    choosePCBPointCandidate(board, layers, candidates, { x: 0, y: 1.9 }, { tolerance: 0.2 })
      ?.selection.id,
    'trace',
    'Copper under the pointer wins over a closer centreline outside its paint.',
  );
});

test('narrow traces and vias beat the larger pad in copper overlap', () => {
  const part = owner(),
    board = {
      ...createEmptyPCB(),
      footprints: [part],
      tracks: [track('trace', { x: -6, y: 0 }, { x: 6, y: 0 })],
    };
  const pad: PCBPointCandidate = { padId: 'pad' },
    candidates = [candidate('footprint', part.id), candidate('track', 'trace'), pad];
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0, y: 0 },
      { tolerance: 0.2, filters },
    ),
    candidates[1],
  );
  const alongTrack = choosePCBPointCandidate(
    board,
    defaultPCBDisplay(),
    candidates,
    { x: 0.4, y: 0 },
    { tolerance: 0.2, filters },
  );
  assert.ok(alongTrack && 'selection' in alongTrack && alongTrack.selection);
  assert.equal(alongTrack.selection.id, 'trace');
  const via = candidate('via', 'via');
  board.vias = [{ id: 'via', x: 0, y: 0, diameter: 0.6, drill: 0.2, netId: 'out' }];
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      [...candidates, via],
      { x: 0, y: 0 },
      { tolerance: 0.2, filters: { ...filters, pad: false } },
    ),
    via,
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      [...candidates, via],
      { x: 0, y: 0 },
      { tolerance: 0.2, filters },
    ),
    via,
  );
});

test('precise hits never read saved fills, while fallback respects visible pours and holes', () => {
  const board = createEmptyPCB(),
    layers = defaultPCBDisplay();
  board.tracks = [track('trace', { x: 1, y: 2 }, { x: 9, y: 2 })];
  board.zones = [
    {
      id: 'pour',
      netId: 'out',
      layer: 'F.Cu',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      filledPolygons: [],
    },
  ];
  let reads = 0;
  const preparedFills = {
    get: () => {
      reads++;
      throw new Error('Precise picks cannot inspect fills.');
    },
  } as unknown as ReadonlyMap<string, never[]>;
  const candidates = [candidate('zone', 'pour'), candidate('track', 'trace')];
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      candidates,
      { x: 5, y: 2 },
      { tolerance: 0.2, preparedFills },
    )?.selection.id,
    'trace',
  );
  assert.equal(reads, 0);
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      candidates,
      { x: 0, y: 5 },
      { tolerance: 0.2, preparedFills },
    )?.selection.id,
    'pour',
  );
  assert.equal(reads, 0);
  layers.zoneOutlines = false;
  const fills = new Map([
    [
      'pour',
      [
        {
          outer: board.zones[0].outline,
          holes: [
            [
              { x: 4, y: 4 },
              { x: 6, y: 4 },
              { x: 6, y: 6 },
              { x: 4, y: 6 },
            ],
          ],
        },
      ],
    ],
  ]);
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      [candidates[0]],
      { x: 2, y: 3 },
      { tolerance: 0.1, preparedFills: fills },
    )?.selection.id,
    'pour',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      [candidates[0]],
      { x: 5, y: 5 },
      { tolerance: 0.1, preparedFills: fills },
    ),
    undefined,
  );
  layers.copper = false;
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      [candidates[0]],
      { x: 2, y: 3 },
      { tolerance: 0.1, preparedFills: fills },
    ),
    undefined,
  );
});

test('hidden layers and disabled filters are excluded before selected-layer priority and identity ties', () => {
  const board = createEmptyPCB(),
    layers = defaultPCBDisplay();
  board.tracks = [
    track('front', { x: -2, y: 0 }, { x: 2, y: 0 }),
    { ...track('back', { x: -2, y: 0 }, { x: 2, y: 0 }), layer: 'B.Cu', locked: true },
  ];
  const candidates = board.tracks.map((item) => candidate('track', item.id));
  const enabled = { ...filters, locked: true };
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      candidates,
      { x: 0, y: 0 },
      { tolerance: 0.2, priorityLayer: 'F.Cu', filters: enabled },
    )?.selection.id,
    'front',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      [...candidates].reverse(),
      { x: 0, y: 0 },
      { tolerance: 0.2, priorityLayer: 'B.Cu', filters: enabled },
    )?.selection.id,
    'back',
  );
  layers['B.Cu'] = false;
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      candidates,
      { x: 0, y: 0 },
      { tolerance: 0.2, priorityLayer: 'B.Cu', filters: enabled },
    )?.selection.id,
    'front',
  );
  layers['B.Cu'] = true;
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      candidates,
      { x: 0, y: 0 },
      { tolerance: 0.2, filters: { ...filters, locked: false } },
    )?.selection.id,
    'front',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      candidates,
      { x: 0, y: 0 },
      { tolerance: 0.2, filters: { ...filters, track: false } },
    ),
    undefined,
  );
  const stable = choosePCBPointCandidate(
    board,
    layers,
    candidates,
    { x: 0, y: 0 },
    { tolerance: 0.2 },
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      [...candidates].reverse(),
      { x: 0, y: 0 },
      { tolerance: 0.2 },
    ),
    stable,
  );
});

test('similar track coverage uses the active copper layer independently of track length', () => {
  const board = createEmptyPCB();
  board.tracks = [
    { ...track('back', { x: -3, y: 0 }, { x: 3, y: 0 }), layer: 'B.Cu' },
    track('front', { x: 0, y: -8 }, { x: 0, y: 8 }),
  ];
  const candidates = board.tracks.map((item) => candidate('track', item.id));
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0, y: 0 },
      { tolerance: 0.2, priorityLayer: 'F.Cu' },
    )?.selection.id,
    'front',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0.15, y: 0 },
      { tolerance: 0.2, priorityLayer: 'F.Cu' },
    )?.selection.id,
    'front',
    'The selected layer wins even when the other layer has a closer centreline.',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0.15, y: 0 },
      { tolerance: 0.2 },
    )?.selection.id,
    'front',
    'The default active copper layer also breaks ties in physical-stack mode.',
  );
  board.tracks[1].width = 0.1;
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0.15, y: 0 },
      { tolerance: 0.2, priorityLayer: 'F.Cu' },
    )?.selection.id,
    'back',
    'An exact hit beats a miss of more than one pixel even on the active layer.',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0, y: 0 },
      { tolerance: 0.2, priorityLayer: 'B.Cu' },
    )?.selection.id,
    'front',
    'A narrow track wins the coverage test before active-layer filtering.',
  );
});

test('viewport numeric ties absorb subpixel pointer noise without hiding a visible geometric offset', () => {
  const board = createEmptyPCB();
  board.tracks = [
    { ...track('back', { x: -7, y: 0 }, { x: 7, y: 0 }), layer: 'B.Cu' },
    track('front', { x: 0, y: -6 }, { x: 0, y: 6 }),
  ];
  const candidates = board.tracks.map((item) => candidate('track', item.id)),
    options = {
      tolerance: 0.2,
      tieTolerance: 0.00001,
      layerOrder: ['B.Cu', 'F.Cu'],
      trackPickup: true,
    };
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: -0.000000976562504, y: 0.000000102996824 },
      options,
    )?.selection.id,
    'front',
  );
  assert.equal(
    choosePCBPointCandidate(board, defaultPCBDisplay(), candidates, { x: 0.15, y: 0 }, options)
      ?.selection.id,
    'back',
  );
});

test('subpixel tie groups are anchored to the closest geometry and cannot depend on candidate order', () => {
  const board = createEmptyPCB();
  board.tracks = [0, 0.01, 0.02].map((y, index) => ({
    ...track(String.fromCharCode(97 + index), { x: -4, y }, { x: 4, y }),
    width: 0.01,
    layer: index ? 'B.Cu' : 'F.Cu',
  }));
  const [a, b, c] = board.tracks.map((item) => candidate('track', item.id));
  for (const items of [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ])
    assert.equal(
      choosePCBPointCandidate(
        board,
        defaultPCBDisplay(),
        items,
        { x: 0, y: 0.03 },
        { tolerance: 0.1, tieTolerance: 0.015, trackPickup: true },
      )?.selection.id,
      'b',
    );
});

test('exact off-layer copper beats a nearby active-layer track and filters expose the pad', () => {
  const part = owner();
  part.side = 'back';
  part.pads[0].layers = ['B.Cu'];
  const board = {
    ...createEmptyPCB(),
    footprints: [part],
    tracks: [
      { ...track('front', { x: -4, y: 0.35 }, { x: 4, y: 0.35 }), width: 0.2 },
      { ...track('back', { x: -4, y: 0 }, { x: 4, y: 0 }), layer: 'B.Cu' as const },
    ],
  };
  const layers = defaultPCBDisplay();
  const pad = { padId: 'pad' };
  const front = candidate('track', 'front');
  const back = candidate('track', 'back');
  const candidates = [pad, back, front];
  const options = { tolerance: 0.3, priorityLayer: 'F.Cu', filters };
  const before = structuredClone(board);
  for (const list of [candidates, candidates.toReversed()]) {
    assert.equal(choosePCBPointCandidate(board, layers, list, { x: 0, y: 0 }, options), back);
    assert.equal(
      choosePCBPointCandidate(board, layers, list, { x: 0, y: 0 }, { tolerance: 0.3, filters }),
      back,
    );
    assert.equal(
      choosePCBPointCandidate(
        board,
        layers,
        list,
        { x: 0, y: 0 },
        {
          ...options,
          filters: { ...filters, track: false },
        },
      ),
      pad,
      'A disabled selected-layer category falls back to eligible geometry.',
    );
  }
  layers['F.Cu'] = false;
  assert.equal(choosePCBPointCandidate(board, layers, candidates, { x: 0, y: 0 }, options), back);
  layers['F.Cu'] = true;
  assert.equal(
    choosePCBPointCandidate(board, layers, candidates, { x: 0, y: -1 }, options),
    undefined,
    'Layer priority never expands the geometric hit tolerance.',
  );
  assert.deepEqual(board, before);
});

test('footprint priority comes from intersected artwork rather than a distant child on the selected layer', () => {
  const part = owner();
  part.graphics.push({
    id: 'distant-back-ink',
    layer: 'B.SilkS',
    width: 0.1,
    start: { x: 20, y: -1 },
    end: { x: 20, y: 1 },
  });
  const board: PCB = {
    ...createEmptyPCB(),
    footprints: [part],
    graphics: [
      {
        id: 'back-ink',
        layer: 'B.SilkS',
        width: 0.1,
        start: { x: -1, y: 0.3 },
        end: { x: 1, y: 0.3 },
      },
    ],
  };
  const body = candidate('footprint', part.id),
    ink = candidate('graphic', 'back-ink');
  const options = { tolerance: 0.3, priorityLayer: 'B.SilkS', filters };
  for (const candidates of [
    [body, ink],
    [ink, body],
  ])
    assert.equal(
      choosePCBPointCandidate(board, defaultPCBDisplay(), candidates, { x: 0, y: 0 }, options),
      ink,
    );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      [body],
      { x: 3, y: 0 },
      {
        ...options,
        priorityLayer: 'F.SilkS',
      },
    ),
    body,
    'Actual footprint artwork remains eligible on its own selected layer.',
  );
});

test('high contrast on a courtyard prefers its footprint over an overlapping board stroke', () => {
  const part = owner();
  const at = { x: 0, y: 0 };
  const stroke = {
    id: 'stroke',
    layer: 'F.CrtYd' as const,
    width: 0.1,
    start: { x: -1, y: 0 },
    end: { x: 1, y: 0 },
  };
  part.graphics.push({ ...stroke, id: 'courtyard' });
  const board = { ...createEmptyPCB(), footprints: [part], graphics: [stroke] };
  const layers = pcbDisplayForLayer(defaultPCBDisplay(), 'F.CrtYd');
  const candidates = [candidate('graphic', stroke.id), candidate('footprint', part.id)];
  const options = { tolerance: 0.15, priorityLayer: 'F.CrtYd', filters };
  assert.equal(choosePCBPointCandidate(board, layers, candidates, at, options), candidates[0]);
  assert.equal(
    choosePCBPointCandidate(board, layers, candidates, at, { ...options, highContrast: true }),
    candidates[1],
  );
});

test('selected inner copper admits shared through pads and Edge.Cuts admits non-plated holes', () => {
  const through = owner();
  through.id = 'through';
  through.pads[0] = {
    ...through.pads[0],
    id: 'through-pad',
    x: 0.2,
    type: 'thru_hole',
    layers: ['*.Cu'],
    drill: 0.3,
  };
  const hole = owner();
  hole.id = 'hole';
  hole.pads[0] = {
    ...hole.pads[0],
    id: 'hole-pad',
    x: 0.2,
    type: 'np_thru_hole',
    drill: 0.5,
  };
  const back = owner();
  back.id = 'back';
  back.side = 'back';
  back.pads[0] = { ...back.pads[0], id: 'back-pad', layers: ['B.Cu'] };
  const board: PCB = {
    ...createEmptyPCB(),
    layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
    footprints: [through, hole, back],
  };
  const candidates = [{ padId: 'back-pad' }, { padId: 'through-pad' }, { padId: 'hole-pad' }];
  const options = { tolerance: 0, filters };
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0, y: 0 },
      {
        ...options,
        priorityLayer: 'In1.Cu',
      },
    )?.padId,
    'through-pad',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 0, y: 0 },
      {
        ...options,
        priorityLayer: 'Edge.Cuts',
      },
    )?.padId,
    'hole-pad',
  );
  const layers = { ...defaultPCBDisplay(), 'Edge.Cuts': false };
  assert.equal(
    choosePCBPointCandidate(
      board,
      layers,
      candidates,
      { x: 0, y: 0 },
      {
        ...options,
        priorityLayer: 'Edge.Cuts',
      },
    )?.padId,
    'back-pad',
    'A hidden selected layer cannot reveal its mechanical holes.',
  );
});

test('footprint text has its own DOM and geometric target, independent of the footprint filter', () => {
  const part = owner();
  part.graphics.push({
    id: 'caption',
    kind: 'text',
    layer: 'F.SilkS',
    width: 0,
    start: { x: 20, y: 20 },
    end: { x: 20, y: 20 },
    text: { value: 'Reference', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 },
  });
  const board = { ...createEmptyPCB(), footprints: [part] },
    plain = candidate('footprint', part.id),
    caption = { ...candidate('graphic', 'caption'), directFootprintText: true };
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      [plain],
      { x: 20, y: 20 },
      { tolerance: 0.2 },
    ),
    undefined,
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      [caption],
      { x: 20, y: 20 },
      { tolerance: 0.2, filters: { ...filters, footprint: false } },
    ),
    caption,
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      [caption],
      { x: 20, y: 20 },
      { tolerance: 0.2, filters: { ...filters, text: false } },
    ),
    undefined,
  );
  assert.deepEqual(selectPCBPoint(board, defaultPCBDisplay(), filters, { x: 20, y: 20 }, 0.2), [
    caption.selection,
  ]);
  assert.equal(
    choosePCBPointCandidate(
      board,
      { ...defaultPCBDisplay(), 'F.SilkS': false },
      [caption],
      { x: 20, y: 20 },
      { tolerance: 0.2 },
    ),
    undefined,
  );
});

test('caption priority follows the glyph layer under the pointer rather than another caption on its owner', () => {
  const part = owner();
  part.graphics = [
    {
      id: 'front-caption',
      kind: 'text',
      layer: 'F.SilkS',
      width: 0,
      start: { x: 20, y: 20 },
      end: { x: 20, y: 20 },
      text: { value: 'Reference', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 },
    },
    {
      id: 'distant-back-caption',
      kind: 'text',
      layer: 'B.SilkS',
      width: 0,
      start: { x: 100, y: 100 },
      end: { x: 100, y: 100 },
      text: { value: 'Value', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 },
    },
  ];
  const board: PCB = {
    ...createEmptyPCB(),
    footprints: [part],
    graphics: [
      {
        id: 'back-stroke',
        layer: 'B.SilkS',
        width: 0.02,
        start: { x: 19, y: 20 },
        end: { x: 21, y: 20 },
      },
    ],
  };
  const caption = {
    ...candidate('graphic', 'front-caption'),
    directFootprintText: true,
  };
  const candidates = [caption, candidate('graphic', 'back-stroke')];
  assert.equal(
    choosePCBPointCandidate(
      board,
      defaultPCBDisplay(),
      candidates,
      { x: 20, y: 20 },
      { tolerance: 0.2, priorityLayer: 'B.SilkS', filters },
    )?.selection.id,
    'back-stroke',
  );
  assert.equal(
    choosePCBPointCandidate(
      board,
      { ...defaultPCBDisplay(), 'B.SilkS': false },
      candidates,
      { x: 20, y: 20 },
      { tolerance: 0.2, priorityLayer: 'B.SilkS', filters },
    )?.selection.id,
    'front-caption',
  );
});

test('overlapping silk, pads and tracks obey silk mode, coverage, visibility and clarification', () => {
  const part = owner();
  part.pads[0].size = { x: 0.4, y: 0.4 };
  const board = {
    ...createEmptyPCB(),
    footprints: [part],
    tracks: [track('trace', { x: -4, y: 0 }, { x: 4, y: 0 })],
    graphics: [
      {
        id: 'legend',
        kind: 'text' as const,
        layer: 'F.SilkS' as const,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
        width: 0,
        text: { value: 'C5', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.15 },
      },
    ],
  };
  const layers = defaultPCBDisplay();
  const at = { x: 0, y: 0 };
  const pad = { padId: 'pad' };
  const legend = candidate('graphic', 'legend');
  const trace = candidate('track', 'trace');
  const candidates = [pad, legend, trace];
  const options = { tolerance: 0.15, filters };
  for (const priorityLayer of ['F.SilkS', 'B.SilkS'])
    assert.equal(
      choosePCBPointCandidate(board, layers, candidates, at, { ...options, priorityLayer }),
      legend,
    );
  const choices: PCBPointCandidate[][] = [];
  const hiddenSilk = { ...layers, 'F.SilkS': false };
  choosePCBPointCandidate(board, hiddenSilk, candidates, at, {
    ...options,
    priorityLayer: 'F.Cu',
    onAmbiguous: (items) => choices.push(items),
  });
  assert.deepEqual(new Set(choices[0]), new Set([pad, trace]));
  assert.equal(
    choosePCBPointCandidate(board, layers, candidates, at, {
      ...options,
      priorityLayer: 'B.SilkS',
      filters: { ...filters, text: false, pad: false },
    }),
    trace,
  );
  board.tracks[0].width = 0.8;
  assert.equal(choosePCBPointCandidate(board, hiddenSilk, candidates, at, options), pad);
  assert.deepEqual(selectPCBPadPoint(board, layers, filters, { x: 0.23, y: 0 }, 0.04), ['pad']);
  assert.deepEqual(selectPCBPadPoint(board, layers, filters, { x: 0.23, y: 0 }, 0.02), []);
  assert.deepEqual(selectPCBPadPoint(board, { ...layers, 'F.Cu': false }, filters, at, 0.04), []);
  board.graphics[0].text.value = 'O';
  board.graphics[0].text.size = { x: 4, y: 4 };
  board.tracks[0].width = 3;
  assert.equal(
    choosePCBPointCandidate(board, layers, [legend, trace], at, options),
    trace,
    'A click in a large character opening hits the exact copper beneath its text box.',
  );
});

test('native EMC C5 silkscreen is selectable, movable and hideable independently through Core', async () => {
  const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  const source = await readFile('project/emc-flyback/emc-flyback.kicad_pcb', 'utf8');
  const board = parseKiCadPCB(source, project.schematic, 'emc-flyback-demo').board;
  const target = { kind: 'graphic' as const, id: '7dedd6e0-f600-404c-a40c-2c8bcb42772c' };
  const hit = findPCBGraphic(board, target.id)!;
  const { graphic, owner } = hit;
  assert.ok(owner && graphic.text?.property === 'Reference');
  const at = footprintPoint(owner, graphic.start);
  const layers = defaultPCBDisplay();
  const footprintTextValues = new Map([[target.id, 'C5']]);
  const options = { footprintTextValues, priorityLayer: 'F.SilkS' as const };
  const candidates = selectPCBPoint(board, layers, filters, at, 0.2, options);
  assert.deepEqual(
    choosePCBPointCandidate(
      board,
      layers,
      candidates.map((selection) => ({ selection })),
      at,
      {
        ...options,
        tolerance: 0.2,
        filters,
      },
    )?.selection,
    target,
  );
  assert.ok(
    selectPCBRectangle(
      board,
      pcbDisplayForLayer(layers, 'F.SilkS'),
      filters,
      { x: at.x - 0.7, y: at.y - 0.5 },
      { x: at.x + 0.7, y: at.y + 0.5 },
      undefined,
      footprintTextValues,
    ).some((item) => item.id === target.id),
  );

  const core = new ProjectCore({ ...project, pcb: board });
  const baseline = core.getNativeFiles();
  const before = core.getSnapshot().project!.pcb!;
  const delta = { x: 1, y: 0.5 };
  const preview = movePCBSelection(before, target, delta);
  assert.equal(core.replaceBoard(preview), true);
  const guiFiles = core.getNativeFiles();
  core.undo();
  assert.deepEqual(core.getNativeFiles(), baseline);
  core.execute('layout.move', { boardId: board.id, selection: [target], delta });
  assert.deepEqual(core.getNativeFiles(), guiFiles);
  const moved = core.getSnapshot().project!.pcb!;
  const movedHit = findPCBGraphic(moved, target.id)!;
  assert.deepEqual(footprintPoint(movedHit.owner!, movedHit.graphic.start), {
    x: at.x + 1,
    y: at.y + 0.5,
  });
  assert.equal(movedHit.owner!.pads, before.footprints.find((item) => item.id === owner.id)!.pads);
  assert.equal(moved.tracks, before.tracks);
  assert.equal(moved.zones, before.zones);
  assert.throws(
    () =>
      replacePCBGraphic(moved, {
        ...movedHit.graphic,
        text: { ...movedHit.graphic.text!, value: 'C99' },
      }),
    /owning component/,
  );
  core.execute('layout.delete', { boardId: board.id, selection: [target] });
  const hidden = core.getSnapshot().project!.pcb!;
  assert.equal(findPCBGraphic(hidden, target.id)?.graphic.text?.hidden, true);
  assert.equal(hidden.footprints.length, board.footprints.length);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), guiFiles);
});

test('the pinned EMC MECH1 fixture does not trap either track from the reported shared-corner case', async () => {
  const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  const board = parseKiCadPCB(
      await readFile('tests/fixtures/emc-track-drag-kicad10-source.kicad_pcb', 'utf8'),
      project.schematic,
      'emc-flyback-demo',
    ).board,
    layers = defaultPCBDisplay();
  const upper = board.tracks.find(
      (item) =>
        item.start.x === 64.8625 &&
        item.start.y === 53.8 &&
        item.end.x === 61 &&
        item.end.y === 57.6625,
    ),
    lower = board.tracks.find(
      (item) =>
        item.start.x === 61 && item.start.y === 57.6625 && item.end.x === 61 && item.end.y === 62.7,
    ),
    mechanical = board.footprints.find((item) => item.reference === 'MECH1');
  assert.ok(upper && lower && mechanical);
  const verify = (basis: PCB, positions: readonly (readonly [Point, string])[]) => {
    for (const [at, expected] of positions) {
      const candidates: PCBPointCandidate[] = selectPCBPoint(basis, layers, filters, at, 0.2).map(
        (selection) => ({ selection }),
      );
      assert.equal(
        choosePCBPointCandidate(basis, layers, candidates, at, {
          tolerance: 0.2,
          priorityLayer: 'F.Cu',
          filters,
        })?.selection?.id,
        expected,
        `Nearest geometry at ${at.x}, ${at.y} wins over MECH1's large empty body.`,
      );
    }
  };
  verify(board, [
    [{ x: 63, y: 55.6625 }, upper.id],
    [{ x: 61, y: 60 }, lower.id],
    [{ x: 61.2, y: 57.4625 }, upper.id],
    [{ x: 61, y: 57.9 }, lower.id],
    [{ x: 100, y: 41 }, mechanical.id],
  ]);
  // The reported screenshot contains a previously moved version of these two
  // source spans. Derive that pose while retaining all real packages/artwork.
  const reported = {
    ...board,
    tracks: board.tracks.map((item) =>
      item.id === upper.id
        ? { ...item, start: { x: 64.862, y: 53.8 }, end: { x: 59.563, y: 53.8 } }
        : item.id === lower.id
          ? { ...item, start: { x: 59.563, y: 53.8 }, end: { x: 58.35, y: 55.013 } }
          : item,
    ),
  };
  verify(reported, [
    [{ x: 61.5, y: 53.8 }, upper.id],
    [{ x: 58.9, y: 54.463 }, lower.id],
    [{ x: 59.45, y: 53.95 }, lower.id],
    [{ x: 59.85, y: 53.8 }, upper.id],
    [{ x: 100, y: 41 }, mechanical.id],
  ]);
});
