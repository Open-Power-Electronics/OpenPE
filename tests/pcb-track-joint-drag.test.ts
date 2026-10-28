import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uid } from '../lib/circuit';
import type { Footprint, PCB } from '../lib/pcb';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject, parseProject, serializeProject } from '../lib/project';
import { createPCBTrackJointDrag } from '../lib/pcb-track-joint-drag';
import { expandPCBTrackSelection } from '../lib/pcb-track-selection';

const fixture = (): PCB => ({
  ...createEmptyPCB(),
  nets: [
    { id: 'out', name: 'OUT' },
    { id: 'gnd', name: 'GND' },
  ],
});
const track = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): PCB['tracks'][number] => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  width: 0.4,
  layer: 'F.Cu',
  netId: 'out',
});
const filters = { footprint: true, track: true, via: true, graphic: true, zone: true };
const connected = (board: PCB, id: string) =>
  new Set(
    expandPCBTrackSelection(
      board,
      [{ kind: 'track', id }],
      defaultPCBDisplay(),
      filters,
      'connected',
    ).map((item) => item.id),
  );
const options = { clearance: 0.25, endpointTolerance: 0.15 };
const pad = (): Footprint => ({
  id: 'part',
  libraryId: 'Test:Corner',
  symbolId: null,
  x: 0,
  y: 0,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id: 'pad',
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'thru_hole',
      shape: 'circle',
      size: { x: 4, y: 4 },
      drill: 2,
      netId: 'out',
    },
  ],
});

test('an existing corner moves freely while both remote endpoints and source metadata stay fixed', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 5, 0), { ...track('b', 5, 0, 5, 5), width: 0.6 }];
  const before = structuredClone(board),
    plan = createPCBTrackJointDrag(board, 'a', { x: 5.05, y: 0.02 }, options);
  assert.deepEqual(plan.anchor, { x: 5, y: 0 });
  assert.equal(plan.kind, 'joint');
  assert.deepEqual(plan.affectedIds, ['a', 'b']);
  const result = plan.preview({ x: 2, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks, [
    { ...board.tracks[0], end: { x: 7, y: 2 } },
    { ...board.tracks[1], start: { x: 7, y: 2 } },
  ]);
  assert.deepEqual(connected(result.board, 'a'), new Set(['a', 'b']));
  assert.deepEqual(board, before);
});

test('interior pickup projects exactly and introduces one stable free-angle bend without dirtying no-op preview', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 10, 0)];
  const plan = createPCBTrackJointDrag(board, 'a', { x: 4.23, y: 1 }, options);
  assert.equal(plan.kind, 'bend');
  assert.deepEqual(plan.anchor, { x: 4.23, y: 0 });
  assert.deepEqual(plan.preview({ x: 0, y: 0 }), { board, error: '', changedIds: [] });
  const result = plan.preview({ x: 1, y: 2 });
  assert.equal(result.error, '');
  assert.equal(result.board.tracks.length, 2);
  assert.deepEqual(result.board.tracks[0], { ...board.tracks[0], end: { x: 5.23, y: 2 } });
  assert.deepEqual(result.board.tracks[1].start, { x: 5.23, y: 2 });
  assert.deepEqual(result.board.tracks[1].end, board.tracks[0].end);
  assert.notEqual(result.board.tracks[1].id, 'a');
  assert.deepEqual(plan.preview({ x: 1, y: 2 }), result);
});

test('native coordinate precision does not turn an untouched corner into an edit', () => {
  const board = fixture();
  board.tracks = [
    track('a', 0.123456789, 0.00000049, 5.123456789, 0.00000049),
    track('b', 5.123456789, 0.00000049, 5.123456789, 5),
  ];
  const before = structuredClone(board),
    plan = createPCBTrackJointDrag(board, 'a', board.tracks[0].end, options);
  assert.equal(plan.kind, 'joint');
  assert.deepEqual(plan.affectedIds, ['a', 'b']);
  for (const delta of [
    { x: 0, y: 0 },
    { x: 0.00000001, y: 0.00000001 },
  ])
    assert.deepEqual(plan.preview(delta), { board, error: '', changedIds: [] });
  const result = plan.preview({ x: 1, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[0].start, board.tracks[0].start);
  assert.deepEqual(result.board.tracks[0].end, result.board.tracks[1].start);
  assert.deepEqual(result.board.tracks[1].end, board.tracks[1].end);
  assert.deepEqual(board, before);
});

test('sub-resolution native joint differences move as one corner without microscopic reconnects', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 5, 0), track('b', 5.0000004, 0.0000003, 5, 5)];
  const plan = createPCBTrackJointDrag(board, 'a', { x: 5, y: 0 }, options),
    result = plan.preview({ x: 1, y: 2 });
  assert.deepEqual(plan.affectedIds, ['a', 'b']);
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks, [
    { ...board.tracks[0], end: { x: 6, y: 2 } },
    { ...board.tracks[1], start: { x: 6, y: 2 } },
  ]);
});

test('endpoint pickup tolerance takes priority over segment projection and shared joints include hidden same-layer arms', () => {
  const board = fixture();
  board.tracks = [
    track('a', 0, 0, 1, 0),
    track('b', 0, 0, 0, 2),
    track('c', 0, 0, -2, -1),
    { ...track('back', 0, 0, 0, -3), layer: 'B.Cu' },
  ];
  const plan = createPCBTrackJointDrag(
    board,
    'a',
    { x: 0.4, y: 0 },
    { ...options, endpointTolerance: 0.6 },
  );
  assert.equal(plan.kind, 'joint');
  assert.deepEqual(plan.anchor, { x: 0, y: 0 });
  assert.deepEqual(plan.affectedIds, ['a', 'b', 'c']);
  const result = plan.preview({ x: 0.5, y: 0.5 });
  assert.equal(result.error, '');
  for (const id of ['a', 'b', 'c'])
    assert.deepEqual(result.board.tracks.find((item) => item.id === id)!.start, { x: 0.5, y: 0.5 });
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === 'back'),
    board.tracks[3],
  );
});

test('other-net endpoints are never part of a moved joint', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 3, 0), { ...track('foreign', 0, 0, 0, -3), netId: 'gnd' }];
  const plan = createPCBTrackJointDrag(board, 'a', { x: 0, y: 0 }, options),
    result = plan.preview({ x: 1, y: 1 });
  assert.deepEqual(plan.affectedIds, ['a']);
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[1], board.tracks[1]);
});

test('a locked selected corner rejects editing and a locked incident arm stays fixed with a reconnect', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 5, 0), { ...track('locked', 5, 0, 5, 5), locked: true }];
  const before = structuredClone(board),
    result = createPCBTrackJointDrag(board, 'a', { x: 5, y: 0 }, options).preview({ x: 2, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[1], board.tracks[1]);
  assert.deepEqual(result.board.tracks[0].end, { x: 7, y: 2 });
  assert.equal(result.board.tracks.length, 3);
  assert.deepEqual(result.board.tracks[2].start, { x: 5, y: 0 });
  assert.deepEqual(result.board.tracks[2].end, { x: 7, y: 2 });
  assert.ok(connected(result.board, 'a').has('locked'));
  assert.deepEqual(board, before);
  const locked = createPCBTrackJointDrag(board, 'locked', { x: 5, y: 0 }, options).preview({
    x: 2,
    y: 2,
  });
  assert.match(locked.error, /Unlock selected tracks/);
  assert.equal(locked.board, board);
  assert.deepEqual(locked.changedIds, []);
});

test('an interior T branch stays at its original breakpoint while the remote joint moves', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 10, 0), track('branch', 4, 0, 4, -3)];
  const result = createPCBTrackJointDrag(board, 'a', { x: 10, y: 0 }, options).preview({
    x: 2,
    y: 2,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[0], { ...board.tracks[0], end: { x: 4, y: 0 } });
  assert.deepEqual(result.board.tracks[1], board.tracks[1]);
  assert.deepEqual(result.board.tracks[2].start, { x: 4, y: 0 });
  assert.deepEqual(result.board.tracks[2].end, { x: 12, y: 2 });
  assert.ok(connected(result.board, 'a').has('branch'));
});

test('a fixed pass-through track at the moved joint receives a direct reconnect instead of losing its branch', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 5, 0), track('crossing', 0, -3, 0, 3)];
  const result = createPCBTrackJointDrag(board, 'a', { x: 0, y: 0 }, options).preview({
    x: 1,
    y: 2,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[1], board.tracks[1]);
  assert.deepEqual(result.board.tracks.at(-1)!.start, { x: 0, y: 0 });
  assert.deepEqual(result.board.tracks.at(-1)!.end, { x: 1, y: 2 });
  assert.ok(connected(result.board, 'a').has('crossing'));
});

test('width-only contacts preserve their unselected copper with a direct checked reconnect', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 4, 0), track('touching', 0, 0.3, 2, 0.3)];
  const result = createPCBTrackJointDrag(board, 'a', { x: 0, y: 0 }, options).preview({
    x: 0,
    y: 2,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[1], board.tracks[1]);
  assert.ok(connected(result.board, 'a').has('touching'));
});

test('short tracks leaving a plated drill hole preserve actual annular contact, including the other layer', () => {
  const board = fixture();
  board.footprints = [pad()];
  board.tracks = [track('a', 0, 0, 1.5, 0), { ...track('back', 2, 0, 3, 0), layer: 'B.Cu' }];
  assert.ok(connected(board, 'a').has('back'));
  const result = createPCBTrackJointDrag(board, 'a', { x: 1.5, y: 0 }, options).preview({
    x: 0,
    y: 3,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.footprints, board.footprints);
  assert.deepEqual(result.board.tracks[1], board.tracks[1]);
  assert.ok(connected(result.board, 'a').has('back'));
});

test('via anchors remain fixed and keep cross-layer copper connected when their coincident corner moves', () => {
  const board = fixture();
  board.vias = [{ id: 'via', x: 0, y: 0, diameter: 0.8, drill: 0.2, netId: 'out' }];
  board.tracks = [track('a', 0, 0, 4, 0), { ...track('back', 0, 0, 0, -3), layer: 'B.Cu' }];
  const result = createPCBTrackJointDrag(board, 'a', { x: 0, y: 0 }, options).preview({
    x: 1,
    y: 2,
  });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.vias, board.vias);
  assert.ok(connected(result.board, 'a').has('back'));
  assert.ok(connected(result.board, 'a').has('via'));
});

test('free-angle editing highlights blocking geometry without detouring, committing, or replacing its source', () => {
  for (const kind of ['foreign', 'edge', 'keepout', 'lettering']) {
    const board = fixture();
    board.tracks = [track('a', 0, 0, 10, 0)];
    if (kind === 'foreign')
      board.vias = [{ id: 'foreign', x: 2.5, y: 1.5, diameter: 0.6, drill: 0.2, netId: 'gnd' }];
    if (kind === 'edge')
      board.graphics = [
        {
          id: 'edge',
          kind: 'polygon',
          layer: 'Edge.Cuts',
          width: 0.1,
          start: { x: -1, y: -1 },
          points: [
            { x: 11, y: -1 },
            { x: 11, y: 3.3 },
          ],
          end: { x: -1, y: 3.3 },
        },
      ];
    if (kind === 'keepout')
      board.zones = [
        {
          id: 'keepout',
          netId: null,
          layer: 'F.Cu',
          outline: [
            { x: 2, y: 1 },
            { x: 3, y: 1 },
            { x: 3, y: 2 },
            { x: 2, y: 2 },
          ],
          clearance: 0.25,
          minThickness: 0.2,
          thermalGap: 0.3,
          thermalBridge: 0.3,
          keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
        },
      ];
    if (kind === 'lettering')
      board.graphics = [
        {
          id: 'text',
          kind: 'text',
          layer: 'F.Cu',
          start: { x: 2.5, y: 1.5 },
          end: { x: 2.5, y: 1.5 },
          width: 0.1,
          text: { value: 'X', rotation: 0, size: { x: 0.1, y: 0.1 }, thickness: 0.05 },
        },
      ];
    const before = structuredClone(board),
      result = createPCBTrackJointDrag(board, 'a', { x: 5, y: 0 }, options).preview({ x: 0, y: 3 });
    assert.match(result.error, /blocked/);
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
    assert.deepEqual(board, before);
  }
});

test('inherited widths and untouched original arm angles remain authoritative without fill recomputation', () => {
  for (const width of [0.000001, 25]) {
    const board = fixture();
    board.tracks = [{ ...track('a', 0, 0, 4, 2), width }];
    board.zones = [
      {
        id: 'pour',
        netId: 'out',
        layer: 'F.Cu',
        outline: [
          { x: -1, y: -1 },
          { x: 5, y: -1 },
          { x: 5, y: 5 },
          { x: -1, y: 5 },
        ],
        clearance: 0.25,
        minThickness: 0.2,
        thermalGap: 0.3,
        thermalBridge: 0.3,
        filledPolygons: [],
      },
    ];
    const result = createPCBTrackJointDrag(board, 'a', { x: 4, y: 2 }, options).preview({
      x: 1,
      y: 1,
    });
    assert.equal(result.error, '');
    assert.equal(result.board.tracks.length, 1);
    assert.equal(result.board.tracks[0].width, width);
    assert.deepEqual(result.board.tracks[0].start, { x: 0, y: 0 });
    assert.deepEqual(result.board.tracks[0].end, { x: 5, y: 3 });
    assert.equal(result.board.zones, board.zones);
  }
});

test('real UUIDs, canonical ordering and all retained metadata survive corner split serialization', () => {
  const board = fixture(),
    netId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  board.tracks = [track('a', 0, 0, 10, 0), track('branch', 4, 0, 4, -3)].map((item) => ({
    ...item,
    id: uid(),
    netId,
  }));
  const original = board.tracks.map((item) => item.id),
    result = createPCBTrackJointDrag(board, original[0], { x: 10, y: 0 }, options).preview({
      x: 2,
      y: 2,
    });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.slice(0, 2).map((item) => item.id),
    original,
  );
  const source = serializeProject({ ...createProject(), pcb: result.board }),
    document = JSON.parse(source);
  const tracks = document.schematic.nets.flatMap(
    (net: { pcb?: { tracks?: { id: string; order: number }[] } }) => net.pcb?.tracks ?? [],
  );
  assert.equal(new Set(tracks.map((item: { id: string }) => item.id)).size, tracks.length);
  assert.deepEqual(
    tracks.map((item: { order: number }) => item.order),
    [0, 1, 2],
  );
  assert.deepEqual(parseProject(source).pcb, result.board);
});

test('fixed-via corner reconnects contain coordinate-only points and survive canonical roundtrip', () => {
  const board = fixture(),
    netId = uid(),
    selectedId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  board.tracks = [{ ...track(selectedId, 0, 0, 4, 0), netId }];
  board.vias = [{ id: uid(), x: 0, y: 0, diameter: 0.8, drill: 0.2, netId }];
  const before = structuredClone(board),
    result = createPCBTrackJointDrag(board, selectedId, { x: 0, y: 0 }, options).preview({
      x: 1,
      y: 2,
    });
  assert.equal(result.error, '');
  assert.equal(
    result.board.tracks.length,
    2,
    'The moved corner has one direct fixed-via reconnect.',
  );
  for (const item of result.board.tracks)
    for (const point of [item.start, item.end])
      assert.deepEqual(Object.keys(point).sort(), ['x', 'y']);
  assert.deepEqual(
    parseProject(serializeProject({ ...createProject(), pcb: result.board })).pcb,
    result.board,
  );
  assert.deepEqual(board, before);
});

test('invalid inputs and collapsed arms fail cleanly without poisoning later valid previews', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 5, 0), track('b', 5, 0, 5, 5)];
  const plan = createPCBTrackJointDrag(board, 'a', { x: 5, y: 0 }, options);
  const collapsed = plan.preview({ x: -5, y: 0 });
  assert.match(collapsed.error, /collapse/);
  assert.equal(collapsed.board, board);
  assert.deepEqual(collapsed.changedIds, []);
  assert.equal(plan.preview({ x: 1, y: 1 }).error, '');
  assert.match(plan.preview({ x: NaN, y: 0 }).error, /coordinates/);
  assert.match(
    createPCBTrackJointDrag(board, 'missing', { x: 0, y: 0 }, options).preview({ x: 0, y: 1 })
      .error,
    /existing track/,
  );
  assert.match(
    createPCBTrackJointDrag(board, 'a', { x: Infinity, y: 0 }, options).preview({ x: 0, y: 1 })
      .error,
    /coordinates/,
  );
  assert.match(
    createPCBTrackJointDrag(
      board,
      'a',
      { x: 0, y: 0 },
      { ...options, endpointTolerance: -1 },
    ).preview({ x: 0, y: 1 }).error,
    /tolerance/,
  );
});

test('joint and fixed-contact complexity bounds reject the complete proposal before changing source geometry', () => {
  const board = fixture();
  board.tracks = Array.from({ length: 257 }, (_, i) => track(`track-${i}`, 0, 0, 1 + i, 1));
  const tooManyArms = createPCBTrackJointDrag(board, 'track-0', { x: 0, y: 0 }, options).preview({
    x: 0,
    y: 1,
  });
  assert.match(tooManyArms.error, /geometry limit/);
  assert.equal(tooManyArms.board, board);
  board.tracks = [
    track('a', 0, 0, 100, 0),
    ...Array.from({ length: 513 }, (_, i) =>
      track(`branch-${i}`, (i + 1) / 10, 0, (i + 1) / 10, -1),
    ),
  ];
  const before = structuredClone(board),
    tooManyContacts = createPCBTrackJointDrag(board, 'a', { x: 100, y: 0 }, options).preview({
      x: 0,
      y: 1,
    });
  assert.match(tooManyContacts.error, /geometry limit/);
  assert.equal(tooManyContacts.board, board);
  assert.deepEqual(board, before);
});
