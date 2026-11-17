import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePCBFillPreview } from '../components/pcbFillPreview';
import { uid, type Point } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { BoardZone, Footprint } from '../lib/pcb';
import { padPolygon, polygonPath } from '../lib/pcb-polygons';
import { ownProjectData } from '../lib/immutable-project';

const rectangle = (x: number, y: number, width: number, height: number): Point[] => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];

function fixture() {
  const board = createEmptyPCB();
  board.nets = [
    { id: uid(), name: 'GND' },
    { id: uid(), name: 'Signal' },
  ];
  board.zones = [
    {
      id: uid(),
      netId: board.nets[0].id,
      layer: 'F.Cu',
      outline: rectangle(0, 0, 30, 20),
      clearance: 0.3,
      minThickness: 0.1,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      fillEnabled: true,
      filledPolygons: [{ points: rectangle(1, 1, 28, 18) }],
    },
  ];
  board.tracks = [
    {
      id: uid(),
      netId: board.nets[1].id,
      layer: 'F.Cu',
      width: 0.4,
      start: { x: 5, y: 10 },
      end: { x: 25, y: 10 },
    },
  ];
  return board;
}

test('owned track poses retain private zone preparation and return independent current masks', () => {
  const basis = ownProjectData(fixture());
  for (const y of [11, 14, 10, 5]) {
    const candidate = ownProjectData(
      {
        ...basis,
        tracks: basis.tracks.map((track) => ({
          ...track,
          start: { ...track.start, y },
          end: { ...track.end, y },
        })),
      },
      basis,
    );
    if (candidate === basis) {
      assert.deepEqual(preparePCBFillPreview(basis, candidate), { changed: false, zones: [] });
      continue;
    }
    const expected = preparePCBFillPreview(structuredClone(basis), structuredClone(candidate));
    const actual = preparePCBFillPreview(basis, candidate);
    assert.deepEqual(actual, expected);
    actual.zones[0].outline = 'mutated public path';
    actual.zones[0].blockers.push({ path: 'mutated public blocker', strokeWidth: 999 });
    assert.deepEqual(preparePCBFillPreview(basis, candidate), expected);
  }
  // An owned replacement must invalidate geometry and fill-rule interpretation.
  for (const edit of [
    { outline: rectangle(3, 2, 15, 10) },
    { holes: [rectangle(8, 5, 2, 2)] },
    { netId: basis.nets[1].id, clearance: 0.8 },
    { fillEnabled: false },
    { layer: 'B.Cu' as const },
  ]) {
    const candidate = ownProjectData({ ...basis, zones: [{ ...basis.zones[0], ...edit }] }, basis);
    assert.deepEqual(
      preparePCBFillPreview(basis, candidate),
      preparePCBFillPreview(structuredClone(basis), structuredClone(candidate)),
    );
  }
});

test('mutable and caller-frozen zone sources are recomputed after in-place outline and rule changes', () => {
  for (const freeze of [false, true]) {
    const basis = ownProjectData(fixture());
    const raw = structuredClone(basis);
    const candidate = freeze ? Object.freeze(raw) : raw;
    preparePCBFillPreview(basis, candidate);
    candidate.zones[0].outline[0].x = 3;
    candidate.zones[0].clearance = 0.8;
    candidate.tracks[0].start.y += 2;
    const actual = preparePCBFillPreview(basis, candidate);
    assert.deepEqual(
      actual,
      preparePCBFillPreview(structuredClone(basis), structuredClone(candidate)),
    );
    assert.equal(actual.zones[0].outline.startsWith('M 3 0'), true);
    assert.equal(actual.zones[0].blockers[0].strokeWidth, 2);
  }
});

test('owned footprint outline variants invalidate retained transforms and rule keys', () => {
  const raw = fixture();
  const local = raw.zones[0];
  raw.zones = [];
  raw.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:Zone',
      x: 10,
      y: 10,
      rotation: 0,
      side: 'front',
      graphics: [],
      pads: [],
      zones: [local],
    },
  ];
  const basis = ownProjectData(raw);
  for (const pose of [{ x: 20 }, { rotation: 90 }, { side: 'back' as const }, { x: 10 }]) {
    const candidate = ownProjectData(
      {
        ...basis,
        footprints: [{ ...basis.footprints[0], ...pose }],
        tracks: basis.tracks.map((track) => ({ ...track, end: { ...track.end, y: 12 } })),
      },
      basis,
    );
    assert.equal(candidate.zones, basis.zones, 'All poses share the same owned board-zone key.');
    assert.deepEqual(
      preparePCBFillPreview(basis, candidate),
      preparePCBFillPreview(structuredClone(basis), structuredClone(candidate)),
    );
  }
});

test('fill masks use only changed foreign copper with exact retained and inherited clearances', () => {
  for (const [clearance, expectedWidth] of [
    [0.3, 1],
    [0, 0.9],
    [0.1, 0.6],
  ]) {
    const basis = fixture();
    basis.zones[0].clearance = clearance;
    const stationary = { ...basis.tracks[0], id: uid() };
    const sameNet = { ...basis.tracks[0], id: uid(), netId: basis.nets[0].id };
    const otherLayer = { ...basis.tracks[0], id: uid(), layer: 'B.Cu' as const };
    basis.tracks.push(stationary, sameNet, otherLayer);
    const candidate = {
      ...basis,
      tracks: basis.tracks.map((track) =>
        track === stationary ? track : { ...track, start: { x: 6, y: 14 }, end: { x: 26, y: 14 } },
      ),
    };
    const before = structuredClone(candidate);
    const preview = preparePCBFillPreview(basis, candidate);
    assert.equal(preview.changed, true);
    assert.equal(preview.zones.length, 1);
    assert.equal(preview.zones[0].needsMask, true);
    assert.equal(preview.zones[0].blockers.length, 1);
    assert.equal(preview.zones[0].blockers[0].path, 'M 6 14 L 26 14');
    assert.ok(Math.abs(preview.zones[0].blockers[0].strokeWidth - expectedWidth) < 1e-10);
    assert.deepEqual(candidate, before);
  }
});

test('same-net moved vias and pads retain drill masks while foreign pads use transformed contours', () => {
  const basis = fixture();
  basis.tracks = [];
  basis.vias = [{ id: uid(), netId: basis.nets[0].id, x: 4, y: 4, diameter: 1, drill: 0.4 }];
  const footprint: Footprint = {
    id: uid(),
    symbolId: null,
    libraryId: 'Test:Pad',
    x: 10,
    y: 10,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'thru_hole',
        shape: 'rect',
        size: { x: 2, y: 3 },
        drill: 1,
        drillOffset: { x: 0.5, y: 0 },
        netId: basis.nets[0].id,
      },
    ],
  };
  basis.footprints = [footprint];
  const moved = { ...footprint, x: 12, rotation: 90 };
  const candidate = { ...basis, footprints: [moved], vias: [{ ...basis.vias[0], x: 6 }] };
  const sameNet = preparePCBFillPreview(basis, candidate).zones[0].blockers;
  assert.equal(sameNet.length, 2, 'Same-net pad/via copper stays visible; both drills are masked.');
  assert.ok(sameNet.every((blocker) => blocker.strokeWidth === 0));
  assert.match(sameNet[0].path, /^M 5\.8 4 A 0\.2/);
  assert.match(sameNet[1].path, /^M 11\.5 9\.5 A 0\.5/);

  const foreign = { ...moved, pads: [{ ...moved.pads[0], netId: basis.nets[1].id }] };
  const blockers = preparePCBFillPreview(basis, { ...candidate, footprints: [foreign] }).zones[0]
    .blockers;
  assert.equal(blockers.length, 3);
  assert.deepEqual(blockers[1], {
    path: polygonPath([padPolygon(foreign, foreign.pads[0])]),
    strokeWidth: 0.6,
  });
  const disconnected = { ...moved, pads: [{ ...moved.pads[0], zoneConnect: 0 }] };
  assert.equal(
    preparePCBFillPreview(basis, { ...candidate, footprints: [disconnected] }).zones[0].blockers
      .length,
    3,
  );
});

test('preview clips follow edited world regions and mask changed keepouts without filling new zones', () => {
  const basis = fixture();
  const candidateZone = {
    ...basis.zones[0],
    outline: rectangle(3, 2, 15, 10),
    holes: [rectangle(8, 5, 2, 2)],
  };
  delete candidateZone.filledPolygons;
  const keepout: BoardZone = {
    ...candidateZone,
    id: uid(),
    netId: null,
    outline: rectangle(10, 3, 3, 3),
    holes: undefined,
    clearance: 0,
    fillEnabled: false,
    keepout: { tracks: false, vias: false, pads: false, copperpour: true, footprints: false },
  };
  const inactive = { ...candidateZone, id: uid(), fillEnabled: false };
  const newUnfilled = { ...candidateZone, id: uid() };
  const candidate = { ...basis, zones: [candidateZone, keepout, inactive, newUnfilled] };
  const preview = preparePCBFillPreview(basis, candidate);
  assert.equal(preview.changed, true);
  assert.equal(preview.zones[0].needsMask, true);
  assert.deepEqual(
    preview.zones.map((zone) => zone.id),
    [basis.zones[0].id],
  );
  assert.equal(
    preview.zones[0].outline,
    polygonPath([{ outer: candidateZone.outline, holes: candidateZone.holes }]),
  );
  assert.deepEqual(preview.zones[0].blockers, [
    { path: polygonPath([{ outer: keepout.outline, holes: [] }]), strokeWidth: 0 },
  ]);
  const margin = preparePCBFillPreview(basis, {
    ...candidate,
    zones: [candidateZone, { ...keepout, clearance: 0.5 }],
  });
  assert.deepEqual(margin.zones[0].blockers, [
    { path: preview.zones[0].blockers[0].path, strokeWidth: 1 },
  ]);
  assert.equal(preparePCBFillPreview(basis, { ...candidate, zones: [] }).zones.length, 0);
  assert.equal(
    preparePCBFillPreview(basis, {
      ...candidate,
      zones: [{ ...candidateZone, fillEnabled: false }],
    }).zones.length,
    0,
  );
});

test('preview transforms footprint-local outlines without reading saved fill vertices or requiring a board outline', () => {
  const basis = fixture();
  const local = basis.zones[0];
  const unreadable = new Proxy(local.filledPolygons!, {
    get() {
      throw new Error('Saved fill vertices must not be traversed for a gesture mask.');
    },
  });
  const footprint: Footprint = {
    id: uid(),
    symbolId: null,
    libraryId: 'Test:Zone',
    x: 10,
    y: 10,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [],
    zones: [{ ...local, outline: rectangle(0, 0, 2, 3), filledPolygons: unreadable }],
  };
  basis.zones = [];
  basis.footprints = [footprint];
  const candidate = { ...basis, footprints: [{ ...footprint, x: 20 }] };
  const preview = preparePCBFillPreview(basis, candidate);
  assert.equal(preview.changed, true);
  assert.equal(preview.zones[0].outline, 'M 20 10 L 22 10 L 22 13 L 20 13 Z');
  assert.equal(preparePCBFillPreview(basis, basis).changed, false);
});

test('mask bounds skip unaffected copper layers and distant regions while board-edge edits remain clipped', () => {
  const basis = fixture();
  const front = basis.zones[0];
  basis.zones.push(
    { ...front, id: uid(), layer: 'B.Cu' },
    { ...front, id: uid(), outline: rectangle(100, 100, 30, 20) },
  );
  const distantPad: Footprint = {
    id: uid(),
    symbolId: null,
    libraryId: 'Test:Pad',
    x: 200,
    y: 200,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'thru_hole',
        shape: 'rect',
        size: { x: 2, y: 2 },
        drill: 1,
        netId: basis.nets[1].id,
      },
    ],
  };
  const candidate = {
    ...basis,
    tracks: [{ ...basis.tracks[0], start: { x: 5, y: 14 }, end: { x: 25, y: 14 } }],
    vias: [{ id: uid(), x: 200, y: 200, netId: basis.nets[1].id, diameter: 1, drill: 0.4 }],
    footprints: [distantPad],
    zones: [
      ...basis.zones,
      {
        ...front,
        id: uid(),
        netId: null,
        outline: rectangle(200, 200, 2, 2),
        keepout: { tracks: false, vias: false, pads: false, copperpour: true, footprints: false },
      },
    ],
  };
  const preview = preparePCBFillPreview(basis, candidate);
  assert.deepEqual(
    preview.zones.map((zone) => zone.needsMask),
    [true, false, false],
  );
  assert.deepEqual(
    preview.zones.map((zone) => zone.blockers.length),
    [1, 0, 0],
  );

  const edge = {
    id: uid(),
    layer: 'Edge.Cuts' as const,
    start: { x: 0, y: 0 },
    end: { x: 30, y: 0 },
    width: 0.1,
  };
  basis.graphics = [edge];
  const boundary = preparePCBFillPreview(basis, {
    ...basis,
    graphics: [{ ...edge, end: { x: 25, y: 0 } }],
  });
  assert.ok(boundary.zones.every((zone) => zone.needsMask));
  basis.footprints = [{ ...distantPad, graphics: [edge] }];
  const movedBoundary = preparePCBFillPreview(basis, {
    ...basis,
    footprints: [{ ...basis.footprints[0], x: 205 }],
  });
  assert.ok(movedBoundary.zones.every((zone) => zone.needsMask));
});
