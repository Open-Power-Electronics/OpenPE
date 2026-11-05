import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { preparePCBTrackPresentation } from '../components/pcbPresentationAnalysis';
import { preparePCBFillPreview } from '../components/pcbFillPreview';
import { uid, type Point } from '../lib/circuit';
import { createEmptyPCB, movePCBSelection } from '../lib/pcb-layout';
import { findPCBRectangle, resizePCBRectangle } from '../lib/pcb-outline-resize';
import { fillCopperZones, filledCopperPolygons } from '../lib/pcb-polygons';
import { createProject, projectFromNativeFiles } from '../lib/project';
import type { PCB } from '../lib/pcb';

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
  const corners = rectangle(0, 0, 30, 20);
  board.graphics = corners.map((start, index) => ({
    id: uid(),
    layer: 'Edge.Cuts',
    width: 0.1,
    start,
    end: corners[(index + 1) % corners.length],
  }));
  board.zones = [
    {
      id: uid(),
      netId: board.nets[0].id,
      layer: 'F.Cu',
      outline: rectangle(1, 1, 28, 18),
      clearance: 0.3,
      minThickness: 0.1,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      fillEnabled: true,
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
  const project = createProject();
  project.pcb = fillCopperZones(board);
  return project;
}

function ringContains(ring: Point[], point: Point) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index],
      b = ring[previous];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

function copperAt(board: PCB, x: number, y: number) {
  const point = { x, y };
  const polygons = filledCopperPolygons(board).get(board.zones[0].id) ?? [];
  return polygons.some(
    (polygon) =>
      ringContains(polygon.outer, point) &&
      !polygon.holes.some((hole) => ringContains(hole, point)),
  );
}

test('track movement dynamically refills copper with GUI/Agent native parity and one undo', async () => {
  const project = fixture();
  const gui = new ProjectCore(project),
    agent = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, agent);
  try {
    const before = agent.getSnapshot();
    const nativeBefore = agent.getNativeFiles();
    const board = before.project!.pcb!;
    const selection = [{ kind: 'track' as const, id: board.tracks[0].id }];
    const delta = { x: 0, y: 4 };
    assert.equal(copperAt(board, 15, 10), false);
    assert.equal(copperAt(board, 15, 14), true);

    const guiBoard = gui.getSnapshot().project!.pcb!;
    const pose = preparePCBTrackPresentation(guiBoard, {
      board: movePCBSelection(guiBoard, selection, delta),
      changedIds: [board.tracks[0].id],
      error: '',
    });
    const visual = preparePCBFillPreview(guiBoard, pose.board);
    assert.equal(visual.changed, true);
    assert.ok(visual.zones[0].blockers.length > 0);
    assert.equal(gui.getSnapshot().undoDepth, 0, 'Preview leaves accepted copper untouched.');
    gui.replaceBoard(pose.board);
    await host.execute(
      'layout.move',
      { boardId: board.id, selection, delta },
      { actor: 'agent', expectedRevision: String(before.revision) },
    );

    const changed = agent.getSnapshot();
    const nativeChanged = agent.getNativeFiles();
    assert.equal(changed.revision, before.revision + 1);
    assert.equal(changed.undoDepth, 1);
    assert.equal(gui.getSnapshot().undoDepth, 1);
    assert.deepEqual(nativeChanged, gui.getNativeFiles());
    assert.equal(copperAt(changed.project!.pcb!, 15, 10), true, 'The old track gap is filled.');
    assert.equal(
      copperAt(changed.project!.pcb!, 15, 14),
      false,
      'The new track retains clearance.',
    );
    const reopened = projectFromNativeFiles(nativeChanged).pcb!;
    assert.equal(copperAt(reopened, 15, 10), true);
    assert.equal(copperAt(reopened, 15, 14), false);

    agent.undo();
    assert.deepEqual(agent.getNativeFiles(), nativeBefore);
    agent.redo();
    assert.deepEqual(agent.getNativeFiles(), nativeChanged);

    const synchronizedBasis = gui.getSnapshot().project!;
    assert.equal(
      gui.materialize(synchronizedBasis, {
        ...synchronizedBasis,
        pcb: movePCBSelection(synchronizedBasis.pcb!, selection, { x: 0, y: -2 }),
      }),
      true,
    );
    assert.equal(gui.getSnapshot().undoDepth, 1, 'Synchronization adds no separate undo edit.');
    assert.equal(copperAt(gui.getSnapshot().project!.pcb!, 15, 12), false);
    assert.equal(copperAt(gui.getSnapshot().project!.pcb!, 15, 14), true);
    gui.undo();
    assert.deepEqual(gui.getNativeFiles(), nativeBefore);
  } finally {
    dispose();
    host.dispose();
  }
});

test('zone resizing and rule-area changes update saved copper in the originating transaction', () => {
  const project = fixture();
  const gui = new ProjectCore(project),
    agent = new ProjectCore(project);
  const board = gui.getSnapshot().project!.pcb!;
  const selection = [{ kind: 'zone' as const, id: board.zones[0].id }];
  const bounds = { minX: 1, minY: 1, maxX: 18, maxY: 19 };
  const before = agent.getNativeFiles();
  assert.equal(copperAt(board, 25, 5), true);
  gui.replaceBoard(resizePCBRectangle(board, findPCBRectangle(board, selection)!, bounds));
  agent.execute('layout.rectangle.resize', { boardId: board.id, selection, bounds });
  assert.deepEqual(agent.getNativeFiles(), gui.getNativeFiles());
  assert.equal(agent.getSnapshot().undoDepth, 1);
  assert.equal(copperAt(agent.getSnapshot().project!.pcb!, 25, 5), false);
  assert.equal(copperAt(agent.getSnapshot().project!.pcb!, 15, 5), true);
  const resized = agent.getNativeFiles();

  agent.execute('layout.zone', {
    boardId: board.id,
    netId: null,
    layer: 'F.Cu',
    outline: rectangle(12, 3, 4, 4),
    keepout: { tracks: false, vias: false, pads: false, copperpour: true, footprints: false },
  });
  const withKeepout = agent.getSnapshot().project!.pcb!;
  assert.equal(withKeepout.zones[0].filledPolygons !== undefined, true);
  assert.equal(copperAt(withKeepout, 14, 5), false);
  assert.equal(copperAt(withKeepout, 8, 5), true);
  assert.equal(agent.getSnapshot().undoDepth, 2);
  // Altering a zone rule uses the same automatic refill, including the existing keepout.
  agent.execute('layout.zone', { boardId: board.id, zoneId: board.zones[0].id, clearance: 0.8 });
  const changed = agent.getSnapshot().project!.pcb!;
  assert.equal(changed.zones[0].clearance, 0.8);
  assert.equal(copperAt(changed, 14, 5), false);
  assert.equal(copperAt(changed, 11.4, 5), false);
  agent.undo();
  agent.undo();
  assert.deepEqual(agent.getNativeFiles(), resized);
  agent.undo();
  assert.deepEqual(agent.getNativeFiles(), before);
});

test('failed dynamic refill and Source, stale-revision and close barriers retain accepted fills', () => {
  const core = new ProjectCore(fixture());
  const before = core.getSnapshot();
  const board = before.project!.pcb!;
  const args = {
    boardId: board.id,
    selection: [{ kind: 'track', id: board.tracks[0].id }],
    delta: { x: 0, y: 4 },
  };
  assert.throws(
    () => core.replaceBoard({ ...board, graphics: board.graphics.slice(1) }),
    /outline.*open|open.*outline/i,
  );
  assert.equal(core.getSnapshot(), before);
  assert.throws(() => core.execute('layout.move', args, { expectedRevision: -1 }), /changed/);
  assert.equal(core.getSnapshot(), before);

  core.updateSource(before.source + '\n');
  assert.throws(() => core.execute('layout.move', args), /Source/);
  assert.equal(core.getSnapshot().project, before.project);
  core.discardSource();
  core.setEditingBlocked('This project is closing.');
  assert.throws(() => core.execute('layout.move', args), /closing/);
  assert.equal(core.getSnapshot().project, before.project);
  core.setEditingBlocked(null);
  core.execute('layout.move', args);
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.equal(copperAt(core.getSnapshot().project!.pcb!, 15, 10), true);
  assert.equal(copperAt(core.getSnapshot().project!.pcb!, 15, 14), false);
});
