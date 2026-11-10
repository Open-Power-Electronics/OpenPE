import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  createPCBPresentationAnalysis,
  preparePCBTrackPresentation,
  preparePCBZoneOutlinePaths,
} from '../components/pcbPresentationAnalysis';
import { ProjectCore } from '../core/project-core';
import { uid } from '../lib/circuit';
import { isOwnedPCB, ownProjectData } from '../lib/immutable-project';
import { invalidatePCBFill, type PCB } from '../lib/pcb';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import type { RuleCheckResult } from '../lib/design-rule-checks';
import { createEmptyPCB } from '../lib/pcb-layout';
import { filledCopperPolygons, polygonPath, refreshPCBFill } from '../lib/pcb-polygons';
import { createPCBTrackDrag } from '../lib/pcb-track-drag';
import { parseProject, projectNativeFiles } from '../lib/project';

function fixture() {
  const board = createEmptyPCB();
  const netId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  board.footprints = [0, 10].map((x) => ({
    id: uid(),
    symbolId: null,
    reference: `J${x + 1}`,
    value: '',
    libraryId: 'Test:Pad',
    x,
    y: 0,
    rotation: 0,
    side: 'front' as const,
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd' as const,
        shape: 'rect' as const,
        size: { x: 2, y: 2 },
        netId,
      },
    ],
  }));
  const points = [
    { x: -1, y: 3 },
    { x: 1, y: 3 },
    { x: 1, y: 5 },
    { x: -1, y: 5 },
  ];
  board.zones = [
    {
      id: uid(),
      netId,
      layer: 'F.Cu',
      outline: points,
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      filledPolygons: [{ points }],
    },
  ];
  return board;
}

test('zone outline paths retain only exact owned shapes and prune committed entries', () => {
  const board = ownProjectData(fixture());
  let calls = 0;
  const render: typeof polygonPath = (polygons) => {
    calls++;
    return polygonPath(polygons);
  };
  const first = preparePCBZoneOutlinePaths(board.zones, new Map(), render);
  assert.equal(calls, board.zones.length);
  const cleared = board.zones.map(({ filledPolygons, ...zone }) => zone);
  const second = preparePCBZoneOutlinePaths(cleared, first.cache, render);
  assert.equal(calls, board.zones.length, 'Fill wrapper changes retain the exact owned outline.');
  assert.deepEqual(second.paths, first.paths);
  const changed = ownProjectData([
    {
      ...cleared[0],
      holes: [
        [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 1, y: 2 },
        ],
      ],
    },
  ]);
  const third = preparePCBZoneOutlinePaths(changed, second.cache, render);
  assert.equal(calls, board.zones.length + 1);
  assert.notEqual(third.paths.get(changed[0].id)?.path, first.paths.get(changed[0].id)?.path);
  const moved = ownProjectData([
    {
      ...changed[0],
      outline: changed[0].outline.map((point, i) => (i ? point : { ...point, x: point.x + 1 })),
    },
  ]);
  preparePCBZoneOutlinePaths(moved, third.cache, render);
  assert.equal(
    calls,
    board.zones.length + 2,
    'An actual outline edit recalculates the exact path.',
  );
  assert.equal(preparePCBZoneOutlinePaths([], third.cache, render).cache.size, 0);

  const mutable = structuredClone(changed);
  Object.freeze(mutable[0]);
  Object.freeze(mutable);
  const unowned = preparePCBZoneOutlinePaths(mutable, third.cache, render);
  assert.equal(unowned.cache.size, 0, 'Caller freezing does not qualify for retention.');
  mutable[0].holes![0][0].x += 1;
  const mutated = preparePCBZoneOutlinePaths(mutable, unowned.cache, render);
  assert.notEqual(mutated.paths.get(changed[0].id)?.path, unowned.paths.get(changed[0].id)?.path);
  assert.throws(
    () =>
      preparePCBZoneOutlinePaths(changed, new Map(), () => {
        throw new Error('path failure');
      }),
    /path failure/,
  );
  const retry = preparePCBZoneOutlinePaths(changed, new Map(), render);
  assert.deepEqual(
    retry.paths.get(changed[0].id),
    third.paths.get(changed[0].id),
    'Failed preparation does not seed a cache.',
  );
});

test('coincident board copper outlines paint once and retain full selection targets', () => {
  const [basis] = fixture().zones;
  const triangle = (id: string, points: [number, number][]) => ({
    ...basis,
    id,
    outline: points.map(([x, y]) => ({ x, y })),
  });
  const upper = triangle('upper', [
    [0, 0],
    [4, 2],
    [0, 3],
  ]);
  const lower = triangle('lower', [
    [4, 2],
    [0, 0],
    [4, 0],
  ]);
  const partial = triangle('partial', [
    [6, 3],
    [2, 1],
    [6, 1],
  ]);
  const nearby = triangle('nearby', [
    [0, 1e-10],
    [4, 2 + 1e-10],
    [2, 4],
  ]);
  const otherLayer = { ...lower, id: 'back', layer: 'B.Cu' as const };
  const ruleArea = {
    ...lower,
    id: 'rule',
    keepout: { tracks: false, vias: false, pads: false, copperpour: true, footprints: false },
  };
  const zones = ownProjectData([upper, lower, partial, nearby, otherLayer, ruleArea]);
  const first = preparePCBZoneOutlinePaths(zones, new Map());
  const fullPath = (zone: PCB['zones'][number]) =>
    polygonPath([{ outer: zone.outline, holes: [] }]);
  assert.deepEqual(first.paths.get('upper'), { path: fullPath(upper) });
  assert.deepEqual(first.paths.get('lower'), {
    path: 'M 0 0 L 4 0 L 4 2',
    target: fullPath(lower),
  });
  assert.deepEqual(first.paths.get('partial'), {
    path: 'M 6 3 L 4 2 M 2 1 L 6 1 L 6 3',
    target: fullPath(partial),
  });
  assert.deepEqual(first.paths.get('back'), { path: fullPath(otherLayer) });
  assert.deepEqual(first.paths.get('rule'), { path: fullPath(ruleArea) });
  assert.deepEqual(first.paths.get('nearby'), { path: fullPath(nearby) });

  const afterRemoval = preparePCBZoneOutlinePaths([zones[1]], first.cache);
  assert.deepEqual(afterRemoval.paths.get('lower'), { path: fullPath(lower) });
});

function counted() {
  const calls = { connectivity: 0, copper: 0 };
  return {
    calls,
    analysis: createPCBPresentationAnalysis({
      connectivity(board) {
        calls.connectivity++;
        return analyzePCBConnectivity(board);
      },
      copper(board) {
        calls.copper++;
        return filledCopperPolygons(board);
      },
    }),
  };
}

test('owned renderer analysis retains successful calculations with independent result containers', () => {
  const board = ownProjectData(fixture());
  const { analysis, calls } = counted();
  const expected = analyzePCBConnectivity(board);
  const first = analysis.connectivity(board);
  assert.deepEqual(first, expected);
  assert.ok(first.edges.length);
  first.edges.pop();
  first.warnings.push('caller');
  const second = analysis.connectivity(board);
  assert.deepEqual(second, expected);
  assert.notEqual(first, second);
  assert.notEqual(first.edges, second.edges);
  assert.throws(() => (second.edges[0].start.x = 999), TypeError);
  const polygons = filledCopperPolygons(board);
  const firstCopper = analysis.copper(board);
  firstCopper.clear();
  const secondCopper = analysis.copper(board);
  assert.deepEqual(secondCopper, polygons);
  assert.notEqual(firstCopper, secondCopper);
  assert.throws(() => (secondCopper.values().next().value![0].outer[0].x = 999), TypeError);
  assert.deepEqual(calls, { connectivity: 1, copper: 1 });
  assert.deepEqual(analysis.connectivity(board), expected);
});

test('mutable and caller-frozen boards recompute after nested geometry changes', () => {
  for (const frozen of [false, true]) {
    const board = fixture();
    if (frozen) Object.freeze(board);
    assert.equal(isOwnedPCB(board), false);
    const { analysis, calls } = counted();
    const before = analysis.connectivity(board);
    const copper = analysis.copper(board);
    board.footprints[1].x += 10;
    board.zones[0].filledPolygons![0].points[0].x -= 1;
    assert.notDeepEqual(analysis.connectivity(board), before);
    assert.notDeepEqual(analysis.copper(board), copper);
    assert.deepEqual(calls, { connectivity: 2, copper: 2 });
  }
});

test('failed connectivity and saved-fill computations remain retryable for an owned board', () => {
  const board = ownProjectData(fixture());
  let connectivity = 0,
    copper = 0;
  const analysis = createPCBPresentationAnalysis({
    connectivity(input) {
      if (++connectivity === 1) throw new Error('Connectivity setup failed.');
      return analyzePCBConnectivity(input);
    },
    copper(input) {
      if (++copper === 1) throw new Error('Saved contours failed.');
      return filledCopperPolygons(input);
    },
  });
  assert.throws(() => analysis.connectivity(board), /Connectivity setup failed/);
  assert.throws(() => analysis.copper(board), /Saved contours failed/);
  assert.deepEqual(analysis.connectivity(board), analyzePCBConnectivity(board));
  assert.deepEqual(analysis.copper(board), filledCopperPolygons(board));
  analysis.connectivity(board);
  analysis.copper(board);
  assert.equal(connectivity, 2);
  assert.equal(copper, 2);
});

test('fill invalidation retains an already empty candidate and clears both saved-fill owners', () => {
  const board = fixture();
  board.footprints[0].zones = [{ ...board.zones[0], id: uid(), filledPolygons: [] }];
  const owned = ownProjectData(board);
  const next = { ...owned, thickness: owned.thickness + 0.1, tracks: [] };
  next.footprints = owned.footprints.map((footprint, index) =>
    index ? footprint : { ...footprint, x: footprint.x + 1 },
  );
  const cleared = invalidatePCBFill(owned, next);
  assert.equal(cleared.zones[0].filledPolygons, undefined);
  assert.equal(cleared.footprints[0].zones![0].filledPolygons, undefined);
  assert.ok(owned.zones[0].filledPolygons);
  for (const candidate of [cleared, ownProjectData(cleared)]) {
    assert.equal(invalidatePCBFill(owned, candidate), candidate);
    assert.equal(invalidatePCBFill(candidate, candidate), candidate);
  }
});

function filledTrackFixture() {
  const board = fixture();
  board.footprints[0].zones = [
    {
      ...board.zones[0],
      id: uid(),
      keepout: { tracks: true, vias: false, pads: true, copperpour: true, footprints: false },
      fillEnabled: false,
    },
  ];
  board.tracks = [
    {
      id: uid(),
      netId: board.nets[0].id,
      layer: 'F.Cu',
      width: 0.3,
      start: { x: -2, y: 0 },
      end: { x: 12, y: 0 },
    },
  ];
  return ownProjectData(board);
}
function trackPose(basis: PCB, y: number, patch: Partial<PCB> = {}) {
  return {
    board: {
      ...basis,
      tracks: basis.tracks.map((track) => ({
        ...track,
        start: { ...track.start, y: track.start.y + y },
        end: { ...track.end, y: track.end.y + y },
      })),
      ...patch,
    },
    error: '',
    changedIds: basis.tracks.map((track) => track.id),
  };
}

test('track poses retain owned fill-free stationary owners while every board and track stays independent', () => {
  const basis = filledTrackFixture();
  const firstRaw = trackPose(basis, 0.5),
    secondRaw = trackPose(basis, -0.5);
  const first = preparePCBTrackPresentation(basis, firstRaw);
  const second = preparePCBTrackPresentation(basis, secondRaw);
  assert.deepEqual(first.board, ownProjectData(invalidatePCBFill(basis, firstRaw.board), basis));
  assert.deepEqual(second.board, ownProjectData(invalidatePCBFill(basis, secondRaw.board), basis));
  assert.notEqual(first, second);
  assert.notEqual(first.board, second.board);
  assert.notEqual(first.board.tracks, second.board.tracks);
  assert.notEqual(first.board.tracks[0], second.board.tracks[0]);
  assert.equal(second.board.zones, first.board.zones);
  assert.equal(second.board.footprints, first.board.footprints);
  assert.notEqual(second.board.zones, basis.zones);
  assert.notEqual(second.board.footprints, basis.footprints);
  assert.equal(second.board.zones[0].filledPolygons, undefined);
  assert.equal(second.board.footprints[0].zones![0].filledPolygons, undefined);
  assert.equal(second.board.footprints[0].zones![0].keepout, basis.footprints[0].zones![0].keepout);
  assert.equal(second.board.footprints[0].zones![0].fillEnabled, false);
  assert.equal(second.board.footprints[0].zones, first.board.footprints[0].zones);
  assert.equal(second.board.zones[0].outline, basis.zones[0].outline);
  assert.ok(basis.zones[0].filledPolygons);
  assert.ok(basis.footprints[0].zones![0].filledPolygons);
  assert.throws(() => second.board.zones.push(basis.zones[0]), TypeError);
  assert.throws(() => (second.board.footprints[0].x += 1), TypeError);
  secondRaw.board.tracks[0].start.x += 10;
  assert.notEqual(second.board.tracks[0].start.x, secondRaw.board.tracks[0].start.x);
});

test('stationary reuse preserves early exits, no-op and lock-only fills, and already fill-free inputs', () => {
  const basis = filledTrackFixture();
  const prepared = preparePCBTrackPresentation(basis, trackPose(basis, 0.5));
  const unchanged = { board: basis, error: '', changedIds: [] };
  assert.equal(preparePCBTrackPresentation(basis, unchanged), unchanged);
  const noOp = preparePCBTrackPresentation(basis, trackPose(basis, 0));
  assert.equal(noOp.board, basis);
  const lockOnly = trackPose(basis, 0, {
    tracks: basis.tracks.map((track) => ({ ...track, locked: true })),
  });
  const locked = preparePCBTrackPresentation(basis, lockOnly);
  assert.equal(locked.board.zones, basis.zones);
  assert.equal(locked.board.footprints, basis.footprints);
  assert.ok(locked.board.zones[0].filledPolygons);
  const alreadyClear = trackPose(basis, 1, {
    zones: prepared.board.zones,
    footprints: prepared.board.footprints,
  });
  const clear = preparePCBTrackPresentation(basis, alreadyClear);
  assert.equal(clear.board.zones, alreadyClear.board.zones);
  assert.equal(clear.board.footprints, alreadyClear.board.footprints);
  const failed = { ...trackPose(basis, 0.75), error: 'Blocked.' };
  assert.equal(preparePCBTrackPresentation(basis, failed), failed);
  for (const frozen of [false, true]) {
    const caller = structuredClone(basis);
    if (frozen) Object.freeze(caller);
    const raw = trackPose(caller, 0.5);
    assert.equal(preparePCBTrackPresentation(caller, raw), raw);
    assert.ok(raw.board.zones[0].filledPolygons);
  }
});

test('changed stationary owners cannot adopt a basis fill-free derivation', () => {
  const basis = filledTrackFixture();
  const warmed = preparePCBTrackPresentation(basis, trackPose(basis, 0.5));
  const changes: [string, Partial<PCB>][] = [
    ['zones', { zones: basis.zones.map((zone) => ({ ...zone, clearance: zone.clearance + 0.1 })) }],
    [
      'footprints',
      {
        footprints: basis.footprints.map((footprint, index) =>
          index ? footprint : { ...footprint, x: footprint.x + 1, rotation: 45 },
        ),
      },
    ],
    ['layers', { layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] }],
    [
      'vias',
      { vias: [{ id: uid(), netId: basis.nets[0].id, x: 3, y: 0, diameter: 0.8, drill: 0.3 }] },
    ],
    [
      'graphics',
      {
        graphics: [
          ...basis.graphics,
          { id: uid(), layer: 'F.SilkS', width: 0.1, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
        ],
      },
    ],
    ['nets', { nets: basis.nets.map((net) => ({ ...net, name: 'Renamed' })) }],
    ['identity', { id: uid() }],
    ['thickness', { thickness: basis.thickness + 0.1 }],
  ];
  for (const [name, patch] of changes) {
    const raw = trackPose(basis, -0.5, patch);
    const next = preparePCBTrackPresentation(basis, raw);
    assert.deepEqual(next.board, ownProjectData(invalidatePCBFill(basis, raw.board), basis), name);
    assert.notEqual(next.board.zones, warmed.board.zones, `${name}: no stationary cache adoption`);
    assert.notEqual(
      next.board.footprints,
      warmed.board.footprints,
      `${name}: package fills are derived anew`,
    );
  }
  const changedBasis = ownProjectData({ ...basis, zones: changes[0][1].zones! }, basis);
  const changed = preparePCBTrackPresentation(changedBasis, trackPose(changedBasis, 0.5));
  assert.notEqual(
    changed.board.zones,
    warmed.board.zones,
    'An independent basis has its own derivation.',
  );
  assert.equal(changed.board.zones[0].clearance, changedBasis.zones[0].clearance);
});

test('failed track detachment cannot poison later stationary retention', () => {
  const basis = filledTrackFixture();
  const invalid = trackPose(basis, 0.5);
  invalid.board.tracks[0].start.x = NaN;
  assert.throws(() => preparePCBTrackPresentation(basis, invalid), /finite/);
  const firstRaw = trackPose(basis, 0.25);
  const first = preparePCBTrackPresentation(basis, firstRaw);
  const secondRaw = trackPose(basis, -0.25);
  const second = preparePCBTrackPresentation(basis, secondRaw);
  assert.deepEqual(first.board, ownProjectData(invalidatePCBFill(basis, firstRaw.board), basis));
  assert.deepEqual(second.board, ownProjectData(invalidatePCBFill(basis, secondRaw.board), basis));
  assert.equal(first.board.zones, second.board.zones);
  assert.equal(first.board.footprints, second.board.footprints);
});

test('candidate accessors cannot substitute stationary owners after invalidation read different geometry', () => {
  const basis = filledTrackFixture();
  const warmed = preparePCBTrackPresentation(basis, trackPose(basis, 0.5));
  const draft = () => {
    const raw = trackPose(basis, -0.5);
    const moved = basis.footprints.map((footprint, index) =>
      index ? footprint : { ...footprint, x: footprint.x + 1 },
    );
    let reads = 0;
    Object.defineProperty(raw.board, 'footprints', {
      enumerable: true,
      get: () => (++reads <= 2 ? moved : basis.footprints),
    });
    return raw;
  };
  const reference = draft();
  const expected = ownProjectData(invalidatePCBFill(basis, reference.board), basis);
  const actual = preparePCBTrackPresentation(basis, draft());
  assert.equal(expected.footprints[0].x, basis.footprints[0].x + 1);
  assert.deepEqual(actual.board, expected);
  assert.notEqual(actual.board.footprints, warmed.board.footprints);
});

test('Proxy reads retain actual stationary edits even when descriptors report the basis owners', () => {
  const basis = filledTrackFixture();
  const warmed = preparePCBTrackPresentation(basis, trackPose(basis, 0.5));
  const draft = (input = basis) => {
    const raw = trackPose(input, -0.5);
    const moved = input.footprints.map((footprint, index) =>
      index ? footprint : { ...footprint, x: footprint.x + 1, value: 'Edited' },
    );
    raw.board = new Proxy(raw.board, {
      get(target, key, receiver) {
        return key === 'footprints' ? moved : Reflect.get(target, key, receiver);
      },
    });
    return raw;
  };
  const reference = draft();
  const expected = ownProjectData(invalidatePCBFill(basis, reference.board), basis);
  const actual = preparePCBTrackPresentation(basis, draft());
  assert.equal(expected.footprints[0].x, basis.footprints[0].x + 1);
  assert.equal(expected.footprints[0].value, 'Edited');
  assert.deepEqual(actual.board, expected);
  assert.notEqual(actual.board.footprints, warmed.board.footprints);
  const next = preparePCBTrackPresentation(basis, trackPose(basis, 0.75));
  assert.equal(next.board.footprints, warmed.board.footprints);

  const coldBasis = ownProjectData(structuredClone(basis));
  const raw = draft(coldBasis);
  const cold = preparePCBTrackPresentation(coldBasis, raw);
  assert.deepEqual(cold.board, ownProjectData(invalidatePCBFill(coldBasis, raw.board), coldBasis));
  const clean = preparePCBTrackPresentation(coldBasis, trackPose(coldBasis, 0.75));
  assert.equal(clean.board.footprints[0].x, coldBasis.footprints[0].x);
  assert.equal(clean.board.footprints[0].value, coldBasis.footprints[0].value);
});

test('EMC dynamic fill preview reuses copper and connectivity and retains Core/native/undo parity', async () => {
  const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  for (const y of [0.5, -0.5]) {
    const core = new ProjectCore(project);
    const basis = core.getSnapshot().project!.pcb!;
    const selected = basis.tracks.find(
      (track) => track.id === '55e76c6c-a882-41a3-85b9-455b1a2d200e',
    )!;
    const engine = createPCBTrackDrag(basis, [{ kind: 'track', id: selected.id }], {
      clearance: 0.25,
    });
    const earlier = engine.preview({ x: 0, y: y / 2 });
    assert.equal(earlier.error, '');
    const earlierPrepared = preparePCBTrackPresentation(basis, earlier);
    const raw = engine.preview({ x: 0, y });
    assert.equal(raw.error, '');
    const prepared = preparePCBTrackPresentation(basis, raw);
    assert.equal(isOwnedPCB(prepared.board), true);
    assert.notEqual(prepared.board, raw.board);
    assert.notEqual(prepared.board, earlierPrepared.board);
    assert.notEqual(prepared.board.tracks, earlierPrepared.board.tracks);
    assert.equal(prepared.board.zones, earlierPrepared.board.zones);
    assert.equal(prepared.board.footprints, earlierPrepared.board.footprints);
    assert.deepEqual(prepared.board, invalidatePCBFill(basis, raw.board));
    assert.equal(invalidatePCBFill(basis, prepared.board), prepared.board);
    const projected = refreshPCBFill(basis, prepared.board);
    assert.equal(isOwnedPCB(projected), true);
    assert.notEqual(projected, prepared.board);
    assert.ok(projected.zones.some((zone) => zone.filledPolygons !== undefined));
    assert.equal(refreshPCBFill(basis, projected), projected);
    const { analysis, calls } = counted();
    const connectivity = analysis.connectivity(projected);
    assert.deepEqual(connectivity, { edges: [], padCount: 194, warnings: [] });
    analysis.copper(projected);
    assert.equal(core.replaceBoard(projected), true);
    const committed = core.getSnapshot().project!;
    assert.equal(
      committed.pcb === projected,
      true,
      'Core adopts the exact displayed dynamic fill.',
    );
    assert.deepEqual(analysis.connectivity(committed.pcb!), connectivity);
    const report = (await core.query('layout.drc', { boardId: basis.id })) as RuleCheckResult;
    assert.equal(report.complete, true, report.notes.join('\n'));
    analysis.copper(committed.pcb!);
    assert.deepEqual(calls, { connectivity: 1, copper: 1 });
    assert.deepEqual(projectNativeFiles(committed), projectNativeFiles(structuredClone(committed)));
    core.undo();
    assert.equal(core.getSnapshot().project!.pcb, basis);
    assert.deepEqual(analysis.connectivity(basis), { edges: [], padCount: 194, warnings: [] });
    assert.deepEqual(analysis.connectivity(basis), { edges: [], padCount: 194, warnings: [] });
    assert.equal(
      calls.connectivity,
      2,
      'The original saved-fill analysis runs once after undo and retains its successful result.',
    );
  }
});

test('preparation detaches successful local records without trusting caller freeze or accepting invalid global IDs', async () => {
  const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  const core = new ProjectCore(project);
  const basis = core.getSnapshot().project!.pcb!;
  const board: PCB = {
    ...basis,
    tracks: basis.tracks.map((track, index) =>
      index ? track : { ...track, start: { ...track.start, x: track.start.x + 0.25 } },
    ),
  };
  const raw = { board, error: '', changedIds: [board.tracks[0].id] };
  const prepared = preparePCBTrackPresentation(basis, raw);
  board.tracks[0].start.x += 5;
  assert.notEqual(prepared.board.tracks[0].start.x, board.tracks[0].start.x);
  const caller = Object.freeze(structuredClone(basis));
  assert.equal(preparePCBTrackPresentation(caller, raw), raw);
  const failed = { ...raw, error: 'Blocked.' };
  assert.equal(preparePCBTrackPresentation(basis, failed), failed);
  const invalid = preparePCBTrackPresentation(basis, {
    board: {
      ...basis,
      tracks: prepared.board.tracks.map((track, index) =>
        index ? track : { ...track, id: core.getSnapshot().project!.schematic.id },
      ),
    },
    error: '',
    changedIds: [prepared.board.tracks[0].id],
  });
  assert.equal(
    invalid.board.zones,
    prepared.board.zones,
    'Invalid global data still exercises a stationary cache hit.',
  );
  assert.equal(invalid.board.footprints, prepared.board.footprints);
  assert.throws(() => core.replaceBoard(invalid.board), /duplicate|unique|UUID/i);
  assert.equal(core.getSnapshot().project!.pcb, basis);
});
