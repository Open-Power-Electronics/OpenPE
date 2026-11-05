import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Point } from '../lib/circuit';
import type { Footprint, PCB } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { parseProject } from '../lib/project';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import {
  choosePCBPointCandidate,
  selectPCBPoint,
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

test('pad and via centres are local features while positions along an underlying track keep choosing that track', () => {
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
    pad,
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
    pad,
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

test('hidden layers and disabled filters are excluded and priority or IDs only resolve genuine ties', () => {
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

test('equal geometric distances use the active copper layer before comparing track lengths', () => {
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
    'back',
    'A genuinely closer centreline still precedes the active layer.',
  );
});

test('viewport numeric ties absorb subpixel pointer noise without hiding a visible geometric offset', () => {
  const board = createEmptyPCB();
  board.tracks = [
    { ...track('back', { x: -7, y: 0 }, { x: 7, y: 0 }), layer: 'B.Cu' },
    track('front', { x: 0, y: -6 }, { x: 0, y: 6 }),
  ];
  const candidates = board.tracks.map((item) => candidate('track', item.id)),
    options = { tolerance: 0.2, tieTolerance: 0.00001, priorityLayer: 'F.Cu' };
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
        { tolerance: 0.1, tieTolerance: 0.015, priorityLayer: 'F.Cu' },
      )?.selection.id,
      'b',
    );
});

test('caption DOM hits remain selectable without enlarging ordinary footprint targets or bypassing text filters', () => {
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
    caption = { ...plain, directFootprintCaption: true };
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
      { tolerance: 0.2 },
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
