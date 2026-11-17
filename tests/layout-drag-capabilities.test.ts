import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { uid } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject } from '../lib/project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { createPCBInteractiveDrag } from '../lib/pcb-interactive-drag';
import { previewConstrainedPCBTrackDrag } from '../lib/pcb-track-drag';

function fixture() {
  const project = createProject();
  const board = createEmptyPCB();
  const netId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  const points = [
    { x: 0, y: 0 },
    { x: 0, y: 5 },
    { x: 10, y: 5 },
    { x: 10, y: 0 },
  ];
  board.tracks = points.slice(1).map((end, index) => ({
    id: uid(),
    start: points[index],
    end,
    width: 0.4,
    layer: 'F.Cu' as const,
    netId,
  }));
  board.vias = [points[0], points[3]].map((point) => ({
    id: uid(),
    ...point,
    netId,
    diameter: 1,
    drill: 0.4,
  }));
  project.pcb = board;
  const core = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  registerProjectCapabilities(host, core);
  return { core, host, board: core.getSnapshot().project!.pcb! };
}

test('Agent drag discovers the canvas parameters, rejects stale/Source edits and reports an explicit constrained pose', async () => {
  const { core, host, board } = fixture();
  const before = core.getSnapshot();
  const native = core.getNativeFiles();
  const input = {
    boardId: board.id,
    selection: [{ kind: 'track' as const, id: board.tracks[1].id }],
    pickup: { x: 5, y: 5 },
    delta: { x: 0, y: -20 },
    clearance: 0.25,
  };
  const definition = host.catalog().find((entry) => entry.id === 'layout.drag')!;
  assert.ok(definition);
  assert.ok(JSON.stringify(definition.inputSchema).includes('previousDelta'));
  await assert.rejects(
    host.execute('layout.drag', input, { actor: 'agent', expectedRevision: '-1' }),
    /changed|revision/i,
  );
  await assert.rejects(
    host.execute('layout.drag', input, { actor: 'agent' }),
    /blocked|collapse|contact/i,
  );
  assert.equal(core.getSnapshot(), before);
  const engine = createPCBInteractiveDrag(board, input.selection, input);
  const preview = previewConstrainedPCBTrackDrag(engine, board, input.delta, false, {
    x: 0,
    y: -2,
  });
  assert.equal(preview.error, '');
  assert.ok(preview.constraint);
  const result = (await host.execute(
    'layout.drag',
    {
      ...input,
      constrain: true,
      previousDelta: { x: 0, y: -2 },
    },
    { actor: 'agent', expectedRevision: String(before.revision) },
  )) as {
    appliedDelta: { x: number; y: number };
    constrained: boolean;
    requestedDelta: { x: number; y: number };
  };
  assert.equal(result.constrained, true);
  assert.deepEqual(result.requestedDelta, input.delta);
  assert.deepEqual(result.appliedDelta, preview.constraint.appliedDelta);
  const geometry = (tracks: typeof board.tracks) => tracks.map(({ id, ...track }) => track);
  assert.deepEqual(
    geometry(core.getSnapshot().project!.pcb!.tracks),
    geometry(preview.board.tracks),
  );
  assert.equal(core.getSnapshot().undoDepth, before.undoDepth + 1);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), native);
  core.updateSource(before.source + '\n');
  await assert.rejects(
    host.execute('layout.drag', { ...input, delta: { x: 0, y: -1 } }, { actor: 'agent' }),
    /Source/,
  );
});

test('Agent picked corner drag uses the canvas engine and rejects ambiguous corner requests atomically', async () => {
  const { core, host, board } = fixture();
  const native = core.getNativeFiles();
  const input = {
    boardId: board.id,
    selection: [{ kind: 'track' as const, id: board.tracks[0].id }],
    mode: 'corner' as const,
    pickup: { x: 0, y: 5 },
    endpointTolerance: 0.15,
    delta: { x: 2, y: 1 },
    clearance: 0.25,
  };
  const { pickup, ...ambiguous } = input;
  await assert.rejects(host.execute('layout.drag', ambiguous, { actor: 'agent' }), /pickup/);
  assert.deepEqual(core.getNativeFiles(), native);
  const preview = createPCBInteractiveDrag(board, input.selection, input).preview(input.delta);
  assert.equal(preview.error, '');
  await host.execute('layout.drag', input, {
    actor: 'agent',
    expectedRevision: String(core.getSnapshot().revision),
  });
  const geometry = (tracks: typeof board.tracks) => tracks.map(({ id, ...track }) => track);
  assert.deepEqual(
    geometry(core.getSnapshot().project!.pcb!.tracks),
    geometry(preview.board.tracks),
  );
  core.undo();
  assert.deepEqual(core.getNativeFiles(), native);
});

function footprintFixture() {
  const project = createProject();
  const board = createEmptyPCB();
  const netId = uid();
  const foreignNet = uid();
  board.nets = [
    { id: netId, name: 'OUT' },
    { id: foreignNet, name: 'GND' },
  ];
  const start = { x: 10.125, y: 10 };
  const joint = { x: 15, y: 10 };
  board.footprints = [
    {
      id: uid(),
      ...start,
      rotation: 0,
      side: 'front',
      symbolId: null,
      libraryId: 'Test:Drag',
      reference: 'J1',
      value: 'Connector',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'thru_hole',
          shape: 'circle',
          size: { x: 1, y: 1 },
          drill: 0.5,
          netId,
        },
      ],
    },
  ];
  board.tracks = [
    { id: uid(), netId, layer: 'F.Cu', width: 0.2, start, end: joint },
    {
      id: uid(),
      netId,
      layer: 'F.Cu',
      width: 0.2,
      start: joint,
      end: { x: 20, y: 10 },
      locked: true,
    },
    {
      id: uid(),
      netId: foreignNet,
      layer: 'B.Cu',
      width: 0.2,
      start: { x: 8, y: 14 },
      end: { x: 13, y: 14 },
    },
  ];
  board.vias = [{ id: uid(), ...joint, netId, diameter: 1, drill: 0.4 }];
  project.pcb = board;
  return { project, board };
}

test('connected footprint drag shares native placement and undo between canvas and Agent', async () => {
  const { project, board } = footprintFixture();
  const canvas = new ProjectCore(project);
  const agent = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  registerProjectCapabilities(host, agent);
  const native = canvas.getNativeFiles();
  const input = {
    boardId: board.id,
    selection: [{ kind: 'footprint' as const, id: board.footprints[0].id }],
    delta: { x: 1, y: 0 },
    clearance: 0.25,
  };
  const basis = canvas.getSnapshot().project!.pcb!;
  const engine = createPCBInteractiveDrag(basis, input.selection, input);
  assert.equal(engine.preview({ x: 0, y: 0 }).board, basis);
  const preview = engine.preview(input.delta);
  assert.equal(preview.error, '');
  assert.deepEqual(preview.changedIds, [board.footprints[0].id, board.tracks[0].id]);
  assert.equal(preview.board.footprints[0].x, 11.125);
  assert.deepEqual(preview.board.tracks[0].start, { x: 11.125, y: 10 });
  assert.equal(preview.board.tracks[1], basis.tracks[1]);
  assert.equal(preview.board.vias[0], basis.vias[0]);
  assert.equal(canvas.replaceBoard(preview.board), true);
  await host.execute('layout.drag', input, { actor: 'agent' });
  assert.deepEqual(agent.getNativeFiles(), canvas.getNativeFiles());
  const reopened = projectFromNativeFiles(agent.getNativeFiles()).pcb!;
  const trackNets = (pcb: typeof board) =>
    pcb.tracks.map(({ netId, ...track }) => ({
      ...track,
      net: pcb.nets.find(({ id }) => id === netId)!.name,
    }));
  assert.deepEqual(trackNets(reopened), trackNets(preview.board));
  assert.deepEqual(
    reopened.footprints.map(({ x, y }) => ({ x, y })),
    [{ x: 11.125, y: 10 }],
  );
  for (const core of [canvas, agent]) {
    assert.equal(core.getSnapshot().undoDepth, 1);
    core.undo();
    assert.deepEqual(core.getNativeFiles(), native);
  }
});

test('footprint drag bends native leads and checks hidden obstacles and same-net islands', () => {
  const { project, board } = footprintFixture();
  board.vias.push({ ...board.vias[0], id: uid(), x: 7, y: 10 });
  const input = {
    boardId: board.id,
    selection: [{ kind: 'footprint' as const, id: board.footprints[0].id }],
    delta: { x: 0, y: 4 },
    clearance: 0.25,
  };
  const core = new ProjectCore(project);
  const basis = core.getSnapshot().project!.pcb!;
  const engine = createPCBInteractiveDrag(basis, input.selection, input);
  const preview = engine.preview({ x: 0, y: 2 });
  assert.equal(preview.error, '');
  assert.equal(preview.board.tracks.length, board.tracks.length + 1);
  assert.equal(preview.board.tracks[0].id, board.tracks[0].id);
  assert.deepEqual(preview.board.tracks[0].start, { x: 10.125, y: 12 });
  assert.deepEqual(preview.board.tracks.at(-1)!.end, board.tracks[0].end);
  assert.deepEqual(engine.preview({ x: 0, y: 2 }), preview);
  assert.match(engine.preview({ x: -3.125, y: 0 }).error, /connectivity/);
  const before = core.getSnapshot();
  assert.throws(() => core.execute('layout.drag', input), /blocked/i);
  assert.equal(core.getSnapshot(), before);
  const constrained = core.execute('layout.drag', { ...input, constrain: true }) as {
    constrained: boolean;
    appliedDelta: { x: number; y: number };
  };
  assert.equal(constrained.constrained, true);
  assert.ok(constrained.appliedDelta.y > 0 && constrained.appliedDelta.y < 4);

  const locked = {
    ...board,
    tracks: [{ ...board.tracks[0], locked: true as const }, ...board.tracks.slice(1)],
  };
  const blocked = createPCBInteractiveDrag(locked, input.selection, input).preview({ x: 0, y: 2 });
  assert.match(blocked.error, /connectivity/);
  assert.equal(blocked.board, locked);
});

test('warm footprint drag matches a cold preview and a blocked pose cannot commit the older board', () => {
  const { project, board } = footprintFixture();
  const input = {
    boardId: board.id,
    selection: [{ kind: 'footprint' as const, id: board.footprints[0].id }],
    delta: { x: 1, y: 0 },
    clearance: 0.25,
  };
  const core = new ProjectCore(project);
  const basis = core.getSnapshot().project!.pcb!;
  const cold = createPCBInteractiveDrag(basis, input.selection, input);
  const warm = createPCBInteractiveDrag(basis, input.selection, input);
  warm.preview({ x: 0.25, y: 0 });
  const copper = (pcb: NonNullable<typeof basis>) => ({
    footprints: pcb.footprints.map(({ id, x, y }) => ({ id, x, y })),
    tracks: pcb.tracks.map(({ id, start, end, width, layer, netId }, index) => ({
      id: index < basis.tracks.length ? id : 'elbow',
      start,
      end,
      width,
      layer,
      netId,
    })),
  });
  for (const delta of [
    { x: 1, y: 0 },
    { x: 0, y: 2 },
    { x: 0, y: 4 },
  ]) {
    const left = cold.preview(delta);
    const right = warm.preview(delta);
    const repeated = warm.preview(delta);
    assert.equal(right.error, left.error);
    assert.deepEqual(copper(right.board), copper(left.board));
    assert.deepEqual(repeated.changedIds, right.changedIds);
    assert.deepEqual(copper(repeated.board), copper(right.board));
  }
  const valid = warm.preview({ x: 0, y: 2 });
  assert.equal(valid.error, '');
  const blocked = warm.preview({ x: 0, y: 4 });
  assert.match(blocked.error, /blocked/i);
  assert.equal(blocked.board, basis);
  assert.notEqual(blocked.board, valid.board);
  const before = core.getSnapshot();
  assert.throws(() => core.execute('layout.drag', { ...input, delta: { x: 0, y: 4 } }), /blocked/i);
  assert.equal(core.getSnapshot(), before);
  const exact = warm.preview(input.delta);
  assert.equal(exact.error, '');
  assert.equal(core.replaceBoard(exact.board), true);
  assert.deepEqual(copper(core.getSnapshot().project!.pcb!), copper(exact.board));
});
