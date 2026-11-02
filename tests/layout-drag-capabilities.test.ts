import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { uid } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject } from '../lib/project';
import { createPCBInteractiveTrackDrag } from '../lib/pcb-interactive-track-drag';
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
  const engine = createPCBInteractiveTrackDrag(board, input.selection, input);
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
  const preview = createPCBInteractiveTrackDrag(board, input.selection, input).preview(input.delta);
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
