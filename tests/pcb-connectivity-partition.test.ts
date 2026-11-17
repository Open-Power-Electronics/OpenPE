import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyPCB } from '../lib/pcb-layout';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import { ownProjectData } from '../lib/immutable-project';
import { copperFillContour } from '../lib/pcb-polygons';
import type { BoardZone, Footprint, PCB } from '../lib/pcb';

type Track = PCB['tracks'][number];

function fixture(nets = 3, pads = 3): PCB {
  const board = createEmptyPCB();
  board.nets = Array.from({ length: nets }, (_, index) => ({
    id: `net-${index}`,
    name: `NET_${index}`,
  }));
  board.footprints = board.nets.flatMap((net, row) =>
    Array.from({ length: pads }, (_, column): Footprint => ({
      id: `footprint-${row}-${column}`,
      symbolId: null,
      reference: `J${row * pads + column + 1}`,
      value: '',
      libraryId: 'Test:Annulus',
      x: column * 10,
      y: row * 20,
      rotation: (column * 45) % 360,
      side: row % 2 ? 'back' : 'front',
      graphics: [],
      pads: [
        {
          id: `pad-${row}-${column}`,
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'thru_hole',
          shape: 'circle',
          size: { x: 4, y: 4 },
          drill: 2,
          drillOffset: { x: 0.25, y: 0 },
          netId: net.id,
        },
      ],
    })),
  );
  board.tracks = board.nets.flatMap((net, row) =>
    Array.from({ length: Math.max(0, pads - 1) }, (_, column): Track => ({
      id: `track-${row}-${column}`,
      netId: net.id,
      layer: row % 2 ? 'B.Cu' : 'F.Cu',
      width: 0.4,
      start: { x: column * 10, y: row * 20 },
      end: { x: (column + 1) * 10, y: row * 20 },
    })),
  );
  return board;
}

test('owned net reuse agrees with full analysis through changed, deleted, split and reordered copper', () => {
  const board = ownProjectData(fixture());
  const changed = (patch: Partial<PCB>) => ownProjectData({ ...board, ...patch }, board);
  const internalLayer = changed({
    layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
    vias: [{ id: 'bridge', x: 0, y: 0, netId: board.nets[0].id, drill: 0.3, diameter: 0.8 }],
    tracks: board.tracks.map((track, index) => (index ? track : { ...track, layer: 'In1.Cu' })),
  });
  const removedLayer = ownProjectData<PCB>(
    { ...internalLayer, layers: ['F.Cu', 'B.Cu'] },
    internalLayer,
  );
  const variants: [string, PCB][] = [
    ['baseline', board],
    [
      'split a connected net',
      changed({ tracks: board.tracks.filter((track) => track.id !== 'track-0-0') }),
    ],
    [
      'move one span',
      changed({
        tracks: board.tracks.map((track, index) =>
          index
            ? track
            : {
                ...track,
                start: { x: 0, y: 4 },
                end: { x: 10, y: 4 },
              },
        ),
      }),
    ],
    [
      'transfer a span to another net',
      changed({
        tracks: board.tracks.map((track, index) =>
          index ? track : { ...track, netId: board.nets[1].id },
        ),
      }),
    ],
    [
      'change width and layer',
      changed({
        tracks: board.tracks.map((track, index) =>
          index ? track : { ...track, width: 0.1, layer: 'In1.Cu' },
        ),
      }),
    ],
    [
      'zero-length span in the drill',
      changed({
        tracks: board.tracks.concat({
          ...board.tracks[0],
          id: 'drill-span',
          start: { x: 0.25, y: 0 },
          end: { x: 0.25, y: 0 },
        }),
      }),
    ],
    ['via and internal layer', internalLayer],
    ['remove internal layers', removedLayer],
    ['reverse tracks', changed({ tracks: [...board.tracks].reverse() })],
    ['reverse footprint order', changed({ footprints: [...board.footprints].reverse() })],
    [
      'changed package geometry',
      changed({
        footprints: board.footprints.map((footprint, index) =>
          index
            ? footprint
            : {
                ...footprint,
                x: 40,
                rotation: 135,
                pads: footprint.pads.map((pad) => ({
                  ...pad,
                  drill: 1,
                  size: { x: 6, y: 6 },
                })),
              },
        ),
      }),
    ],
    [
      'removed copper net',
      changed({
        tracks: board.tracks.filter((track) => track.netId !== board.nets[1].id),
        footprints: board.footprints.filter(
          (footprint) => footprint.pads[0].netId !== board.nets[1].id,
        ),
        nets: board.nets.filter((net) => net.id !== board.nets[1].id),
      }),
    ],
  ];
  for (const [name, next] of [...variants, ...variants.toReversed()]) {
    const expected = analyzePCBConnectivity(structuredClone(next));
    assert.deepEqual(analyzePCBConnectivity(next), expected, name);
    assert.deepEqual(analyzePCBConnectivity(next), expected, `${name}, repeated`);
  }
  assert.equal(analyzePCBConnectivity(variants[1][1]).edges.length, 1);
  assert.equal(analyzePCBConnectivity(internalLayer).edges.length, 0);
  assert.equal(analyzePCBConnectivity(removedLayer).edges.length, 1);
});

const rectangle = (x1: number, y1: number, x2: number, y2: number) => [
  { x: x1, y: y1 },
  { x: x2, y: y1 },
  { x: x2, y: y2 },
  { x: x1, y: y2 },
];
function zone(id: string, netId: string, y: number): BoardZone {
  return {
    id,
    netId,
    layer: 'F.Cu',
    outline: rectangle(-5, y - 5, 25, y + 5),
    clearance: 0.25,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    filledPolygons: [{ points: rectangle(-3, y - 3, 23, y + 3) }],
  };
}
function withoutFill(zone: BoardZone): BoardZone {
  const next = { ...zone };
  delete next.filledPolygons;
  return next;
}

test('saved board and package fills invalidate the right net results through holes, clearing and transforms', () => {
  const data = fixture(2);
  data.tracks = [];
  data.zones = [zone('board-fill', data.nets[1].id, 20)];
  data.footprints[0].zones = [zone('package-fill', data.nets[0].id, 0)];
  const board = ownProjectData(data);
  assert.equal(analyzePCBConnectivity(board).edges.length, 0);
  const variants = [
    ownProjectData({ ...board, zones: board.zones.map(withoutFill) }, board),
    ownProjectData(
      {
        ...board,
        zones: board.zones.map((zone) => ({
          ...zone,
          filledPolygons: [
            {
              points: copperFillContour({
                outer: rectangle(-3, 17, 23, 23),
                holes: [rectangle(7, 17.5, 13, 22.5)],
              }),
            },
          ],
        })),
      },
      board,
    ),
    ownProjectData(
      { ...board, zones: board.zones.map((zone) => ({ ...zone, layer: 'In1.Cu' as const })) },
      board,
    ),
    ownProjectData(
      { ...board, zones: board.zones.map((zone) => ({ ...zone, fillEnabled: false })) },
      board,
    ),
    ownProjectData(
      {
        ...board,
        footprints: board.footprints.map((footprint, index) =>
          index
            ? footprint
            : {
                ...footprint,
                x: 1,
                rotation: 90,
              },
        ),
      },
      board,
    ),
    ownProjectData(
      {
        ...board,
        footprints: board.footprints.map((footprint, index) =>
          index
            ? footprint
            : {
                ...footprint,
                zones: footprint.zones!.map(withoutFill),
              },
        ),
      },
      board,
    ),
  ];
  for (const next of [...variants, board, ...variants.toReversed()]) {
    const expected = analyzePCBConnectivity(structuredClone(next));
    assert.deepEqual(analyzePCBConnectivity(next), expected);
    assert.deepEqual(analyzePCBConnectivity(next), expected);
  }
  assert.equal(analyzePCBConnectivity(variants[0]).edges.length, 2);
  assert.equal(analyzePCBConnectivity(variants[1]).edges.length, 1);
});

test('cached net airwires stay independent and mutable or caller-frozen boards recompute contacts', () => {
  const data = fixture(2);
  data.tracks = [];
  const board = ownProjectData(data);
  const expected = analyzePCBConnectivity(structuredClone(board));
  const result = analyzePCBConnectivity(board);
  result.edges[0].start.x = 999;
  result.edges[0].end.y = 999;
  result.edges[0].netId = 'escaped';
  result.edges.splice(1);
  result.warnings.push('escaped');
  assert.deepEqual(analyzePCBConnectivity(board), expected);
  const caller = Object.freeze({ ...board, tracks: [structuredClone(fixture(2).tracks[0])] });
  assert.equal(analyzePCBConnectivity(caller).edges.length, 3);
  caller.tracks[0].end = { x: 20, y: 0 };
  assert.equal(analyzePCBConnectivity(caller).edges.length, 2);
  caller.tracks[0].netId = board.nets[1].id;
  assert.deepEqual(analyzePCBConnectivity(caller), analyzePCBConnectivity(structuredClone(caller)));
});

test('ownership alone cannot reuse the same raw copper object under a different role', () => {
  const data = fixture(1, 2);
  const board = ownProjectData({
    ...data,
    tracks: [{ ...data.tracks[0], x: 5, y: 0, diameter: 0.8, drill: 0.4 }],
  });
  assert.equal(analyzePCBConnectivity(board).edges.length, 0);
  // This pure-domain input is not a valid Core PCB. Ownership certifies only
  // detached JSON; the source object's role is still part of the cache key.
  const changed = ownProjectData(
    {
      ...board,
      tracks: [],
      vias: [board.tracks[0] as unknown as PCB['vias'][number]],
    },
    board,
  );
  assert.equal(changed.vias[0], board.tracks[0]);
  const expected = analyzePCBConnectivity(structuredClone(changed));
  assert.equal(expected.edges.length, 1);
  assert.deepEqual(analyzePCBConnectivity(changed), expected);
  assert.equal(analyzePCBConnectivity(board).edges.length, 0);
});

test('cached net work retains the complete aggregate limit after a previously connected net splits', () => {
  const data = fixture(2, 1500);
  data.footprints.forEach((footprint) => {
    footprint.rotation = 0;
    footprint.pads[0].type = 'smd';
    footprint.pads[0].shape = 'rect';
    footprint.pads[0].size = { x: 0.1, y: 0.1 };
    delete footprint.pads[0].drill;
    delete footprint.pads[0].drillOffset;
  });
  const bridges = data.nets.map((net, row): Track => ({
    id: `bridge-${row}`,
    netId: net.id,
    layer: row ? 'B.Cu' : 'F.Cu',
    width: 0.1,
    start: { x: 0, y: row * 20 },
    end: { x: 14990, y: row * 20 },
  }));
  data.tracks = [];
  const board = ownProjectData(data);
  for (const bridge of bridges) {
    const connected = ownProjectData({ ...board, tracks: [bridge] }, board);
    assert.equal(analyzePCBConnectivity(connected).edges.length, 1499);
  }
  const limit = /Airwire preview exceeds the geometry limit/;
  assert.throws(() => analyzePCBConnectivity(structuredClone(board)), limit);
  assert.throws(
    () => analyzePCBConnectivity(board),
    limit,
    'The unchanged net still charges its MST work.',
  );
  assert.throws(
    () => analyzePCBConnectivity(board),
    limit,
    'Failure publishes no partial acceptance.',
  );
  const connected = ownProjectData({ ...board, tracks: bridges }, board);
  assert.deepEqual(analyzePCBConnectivity(connected), { edges: [], padCount: 3000, warnings: [] });
  const tooManyPads = ownProjectData({
    ...connected,
    footprints: connected.footprints.concat({
      ...connected.footprints[0],
      id: 'extra-package',
      pads: [{ ...connected.footprints[0].pads[0], id: 'extra-pad' }],
    }),
  });
  assert.throws(() => analyzePCBConnectivity(tooManyPads), /3000 assigned pads/);
});

test('cached nets retain global body and saved-fill vertex bounds', () => {
  const data = fixture(1, 0);
  data.tracks = Array.from({ length: 15000 }, (_, index): Track => ({
    id: `span-${index}`,
    netId: data.nets[0].id,
    layer: 'F.Cu',
    width: 0.1,
    start: { x: index * 10, y: 0 },
    end: { x: index * 10 + 1, y: 0 },
  }));
  const board = ownProjectData(data);
  assert.deepEqual(analyzePCBConnectivity(board), { edges: [], padCount: 0, warnings: [] });
  const tooManyBodies = ownProjectData(
    {
      ...board,
      tracks: board.tracks.concat({
        ...board.tracks[0],
        id: 'extra-span',
        start: { x: -10, y: 0 },
        end: { x: -9, y: 0 },
      }),
    },
    board,
  );
  assert.throws(() => analyzePCBConnectivity(tooManyBodies), /15000 copper objects/);
  const fillBoard = ownProjectData({ ...board, tracks: board.tracks.slice(0, 1) }, board);
  analyzePCBConnectivity(fillBoard);
  const tooManyVertices = ownProjectData(
    {
      ...fillBoard,
      zones: [
        {
          ...zone('large-fill', data.nets[0].id, 0),
          filledPolygons: [
            { points: Array.from({ length: 60001 }, (_, index) => ({ x: index, y: index % 2 })) },
          ],
        },
      ],
    },
    fillBoard,
  );
  assert.throws(() => analyzePCBConnectivity(tooManyVertices), /60000-vertex board limit/);
  assert.deepEqual(analyzePCBConnectivity(board), { edges: [], padCount: 0, warnings: [] });
});
