import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { uid } from '../lib/circuit';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import { createEmptyPCB, padPosition } from '../lib/pcb-layout';
import { suggestPCBPlacement } from '../lib/pcb-placement-suggestion';
import { createProject } from '../lib/project';

function fixture() {
  const board = createEmptyPCB();
  const netId = uid();
  const foreignNet = uid();
  board.nets = [
    { id: netId, name: 'Signal' },
    { id: foreignNet, name: 'Other' },
  ];
  board.footprints = [10, 20, 30].map((x, index) => ({
    id: uid(),
    x,
    y: 10,
    rotation: 0,
    side: 'front',
    symbolId: null,
    libraryId: 'Test:Placement',
    reference: 'R' + (index + 1),
    value: '1k',
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'rect',
        size: { x: 1, y: 1 },
        netId,
      },
    ],
  }));
  const selection = board.footprints
    .slice(0, 2)
    .map(({ id }) => ({ id, kind: 'footprint' as const }));
  return { board, selection, netId, foreignNet };
}

function frame(x: number, y: number, right: number, bottom: number) {
  const corners = [
    { x, y },
    { x: right, y },
    { x: right, y: bottom },
    { x, y: bottom },
  ];
  return corners.map((start, index) => ({
    id: uid(),
    layer: 'Edge.Cuts' as const,
    width: 0.05,
    start,
    end: corners[(index + 1) % corners.length],
  }));
}

test('suggestions require a closed outline and a wholly off-board group', () => {
  const { board, selection } = fixture();
  const [first, second] = board.footprints;
  const suggest = (items = selection) =>
    suggestPCBPlacement(board, items, analyzePCBConnectivity(board).edges, 0.5, 0.25);
  assert.equal(suggest(), null);
  board.graphics = frame(0, 0, 40, 24);
  assert.equal(suggest(), null);
  first.y = -6;
  assert.equal(suggest(), null);
  second.y = -6;
  assert.equal(suggest(selection.slice(0, 1)), null);
  assert.ok(suggest());
});

test('disconnected footprints get an on-board plan that honors footprint-only keepouts', () => {
  const { board, selection, foreignNet } = fixture();
  board.graphics = frame(0, 0, 36, 20);
  for (const footprint of board.footprints) footprint.pads[0].netId = null;
  board.footprints[0].y = board.footprints[1].y = -6;
  const zone = {
    id: uid(),
    netId: null,
    layer: 'F.Cu' as const,
    clearance: 0,
    minThickness: 0.2,
    thermalGap: 0.25,
    thermalBridge: 0.25,
    outline: [
      { x: 0, y: 0 },
      { x: 24, y: 0 },
      { x: 24, y: 20 },
      { x: 0, y: 20 },
    ],
    keepout: { tracks: false, vias: false, pads: false, copperpour: false, footprints: true },
  };
  board.zones = [zone];
  board.vias = [{ id: uid(), x: 26, y: 10, diameter: 0.8, drill: 0.4, netId: foreignNet }];
  const suggestion = suggestPCBPlacement(board, selection, [], 0.5, 0.25);
  assert.ok(suggestion);
  assert.equal(suggestion.offsets.size, 2);
  for (const part of suggestion.board.footprints.slice(0, 2)) {
    assert.ok(part.x > 24.5 && part.x < 35.5);
    assert.ok(Math.hypot(part.x - 26, part.y - 10) > 0.9);
  }
  assert.equal(suggestion.board.footprints[2], board.footprints[2]);
  assert.equal(suggestion.board.zones, board.zones);
  zone.outline[1].x = zone.outline[2].x = 36;
  assert.equal(suggestPCBPlacement(board, selection, [], 0.5, 0.25), null);
});

test('congested anchor regions leave exact checks available for other parts of the board', () => {
  const { board, selection, foreignNet } = fixture();
  const [first, second, anchor] = board.footprints;
  first.y = second.y = -12;
  Object.assign(anchor, { x: 50, y: 38 });
  board.graphics = frame(0, 0, 100, 76);
  board.zones = [
    {
      id: uid(),
      netId: null,
      layer: 'F.Cu',
      clearance: 0,
      minThickness: 0.2,
      thermalGap: 0.25,
      thermalBridge: 0.25,
      outline: [
        { x: 40, y: 28 },
        { x: 60, y: 28 },
        { x: 60, y: 48 },
        { x: 40, y: 48 },
      ],
      keepout: { tracks: false, vias: false, pads: true, copperpour: false, footprints: false },
    },
  ];
  board.tracks = [
    {
      id: uid(),
      start: { x: 22, y: 42 },
      end: { x: 75, y: 42 },
      width: 0.3,
      netId: foreignNet,
      layer: 'B.Cu',
      locked: true,
    },
  ];
  const edges = analyzePCBConnectivity(board).edges;
  const result = suggestPCBPlacement(board, selection, edges, 0.5, 0.25);
  assert.ok(result);
  assert.equal(result.offsets.size, 2);
  for (const { x, y } of result.board.footprints.slice(0, 2))
    assert.ok(x < 39.5 || x > 60.5 || y < 27.5 || y > 48.5);
  assert.equal(result.board.tracks, board.tracks);
  assert.equal(result.board.footprints[2], anchor);
});

test('GUI and Agent off-board placement share exact native poses, stationary copper and undo', async () => {
  const { board, selection, foreignNet } = fixture();
  const [first, second, anchor] = board.footprints;
  Object.assign(first, { x: 7, y: -10 });
  Object.assign(second, { x: 14, y: -10 });
  Object.assign(anchor, { x: 17, y: 9 });
  first.pads[0].x = -2;
  second.pads[0].x = -2;
  second.pads[0].netId = foreignNet;
  anchor.pads.push({ ...anchor.pads[0], id: uid(), number: '2', x: 4, netId: foreignNet });
  anchor.pads[0].x = -4;
  board.graphics = [...frame(0, 0, 30, 24), ...frame(4, 2, 9, 6)];
  board.tracks = [
    {
      id: uid(),
      start: { x: 6, y: 16 },
      end: { x: 9, y: 16 },
      layer: 'F.Cu',
      width: 0.3,
      netId: foreignNet,
    },
  ];
  const project = { ...createProject(), pcb: board };
  const core = new ProjectCore(project);
  const agent = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  registerProjectCapabilities(host, agent);
  const snapshot = core.getSnapshot();
  const before = core.getNativeFiles();
  const basis = snapshot.project!.pcb!;
  const { edges } = analyzePCBConnectivity(basis);
  const suggestion = suggestPCBPlacement(basis, selection, edges, 1, 0.25);
  assert.ok(suggestion);
  assert.equal(suggestion.offsets.size, 2);
  const poses = suggestion.board.footprints.slice(0, 2);
  const input = { boardId: board.id, footprintIds: selection.map(({ id }) => id), spacing: 1 };
  const actor = { actor: 'agent' } as const;
  const preview = (await host.query('layout.placement.preview', input, actor)) as {
    poses: { id: string; x: number; y: number; rotation: number }[];
  };
  assert.deepEqual(
    preview.poses,
    poses.map(({ id, x, y, rotation }) => ({ id, x, y, rotation })),
  );
  assert.deepEqual(agent.getNativeFiles(), before);
  const apply = { ...input, poses: preview.poses };
  const tampered = [{ ...preview.poses[0], x: preview.poses[0].x + 1 }, ...preview.poses.slice(1)];
  await assert.rejects(
    host.execute('layout.placement.apply', { ...input, poses: tampered }, actor),
    /changed/,
  );
  agent.updateSource(agent.getSnapshot().source + '\n');
  await assert.rejects(host.query('layout.placement.preview', input, actor), /Source/);
  await assert.rejects(host.execute('layout.placement.apply', apply, actor), /Source/);
  agent.discardSource();
  agent.setEditingBlocked('This project is closing.');
  await assert.rejects(host.query('layout.placement.preview', input, actor), /closing/);
  await assert.rejects(host.execute('layout.placement.apply', apply, actor), /closing/);
  agent.setEditingBlocked(null);
  const accepted = await host.execute('layout.placement.apply', apply, actor);
  assert.deepEqual(accepted, {
    poses: preview.poses,
    revision: String(agent.getSnapshot().revision),
  });
  assert.equal(suggestion.board.tracks, basis.tracks);
  const pads = poses.map((part) => padPosition(part, part.pads[0]));
  assert.ok(pads.every(({ x, y }) => x > 0.5 && x < 29.5 && y > 0.5 && y < 23.5));
  assert.ok(pads.every(({ x, y }) => x < 3.5 || x > 9.5 || y < 1.5 || y > 6.5));
  assert.notDeepEqual(suggestion.offsets.get(first.id), suggestion.offsets.get(second.id));
  assert.equal(suggestion.board.footprints[2], basis.footprints[2]);
  assert.equal(core.getSnapshot(), snapshot);
  assert.ok(core.replaceBoard(suggestion.board));
  assert.deepEqual(agent.getNativeFiles(), core.getNativeFiles());
  await assert.rejects(host.execute('layout.placement.apply', apply, actor), /changed/);
  assert.equal(agent.getSnapshot().undoDepth, 1);
  assert.ok(agent.undo());
  assert.deepEqual(agent.getNativeFiles(), before);
  host.dispose();
  const reopened = projectFromNativeFiles(core.getNativeFiles()).pcb!;
  const positions = (parts: typeof poses) =>
    parts.map(({ id, x, y, rotation }) => ({ id, x, y, rotation: (rotation + 360) % 360 }));
  assert.deepEqual(positions(reopened.footprints), positions(suggestion.board.footprints));
  assert.ok(core.undo());
  assert.deepEqual(core.getNativeFiles(), before);
  assert.equal(core.undo(), false);
  first.locked = true;
  assert.equal(suggestPCBPlacement(board, selection, edges, 1, 0.25), null);
});

test('independent quarter turns fit a narrow board when the unrotated packages are too wide', () => {
  const { board, selection } = fixture();
  board.graphics = frame(0, 0, 6, 24);
  for (const part of board.footprints.slice(0, 2)) {
    part.y = -12;
    part.pads[0].x = -4;
    part.pads.push({ ...part.pads[0], id: uid(), number: '2', x: 4, netId: null });
  }
  const result = suggestPCBPlacement(board, selection, [], 0.5, 0.25);
  assert.ok(result);
  for (const part of result.board.footprints.slice(0, 2)) {
    assert.equal((part.rotation + 360) % 180, 90);
    assert.ok(part.x > 0.5 && part.x < 5.5 && part.y > 4.5 && part.y < 19.5);
  }
});
