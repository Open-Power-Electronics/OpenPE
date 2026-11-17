import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { uid, type Point } from '../lib/circuit';
import { createBlankProject } from '../lib/create-blank-project';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { fillCopperZones } from '../lib/pcb-polygons';
import {
  pcbRegionFilletOutline,
  preparePCBRegionFillet,
  type PCBRegionTarget,
} from '../lib/pcb-region-fillet';

const rectangle = (min: number, max: number): Point[] => [
  { x: min, y: min },
  { x: max, y: min },
  { x: max, y: max },
  { x: min, y: max },
];

function fixture() {
  const project = createBlankProject();
  const board = project.pcb!;
  const corners = rectangle(0, 20);
  board.graphics = [
    {
      id: uid(),
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.05,
      stroke: 'default',
      start: corners[0],
      points: corners.slice(1, -1),
      end: corners.at(-1)!,
      fill: false,
    },
  ];
  board.nets = [{ id: uid(), name: 'GND' }];
  board.zones = [
    {
      id: uid(),
      netId: board.nets[0].id,
      layer: 'F.Cu',
      outline: rectangle(2, 18),
      holes: [rectangle(8, 12)],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      fillEnabled: false,
      priority: 7,
    },
  ];
  return project;
}

test('region fillets preserve tangent endpoints, winding and the circular chord tolerance', () => {
  const board = fixture().pcb!;
  const target: PCBRegionTarget = { kind: 'zone', id: board.zones[0].id };
  const baseline = structuredClone(board);
  const outline = pcbRegionFilletOutline(board, target, 2);
  const count = outline.length / 4;
  assert.equal(Number.isInteger(count), true);
  assert.deepEqual(outline[0], { x: 2, y: 4 });
  assert.deepEqual(outline[count - 1], { x: 4, y: 2 });
  for (let i = 0; i < count; i++) {
    assert.ok(Math.abs(Math.hypot(outline[i].x - 4, outline[i].y - 4) - 2) < 0.000001);
    if (i) {
      const midpoint = {
        x: (outline[i - 1].x + outline[i].x) / 2,
        y: (outline[i - 1].y + outline[i].y) / 2,
      };
      assert.ok(2 - Math.hypot(midpoint.x - 4, midpoint.y - 4) <= 0.01);
    }
  }
  board.zones[0].outline.reverse();
  const clockwise = pcbRegionFilletOutline(board, target, 2);
  assert.deepEqual(clockwise[0], { x: 2, y: 16 });
  assert.deepEqual(clockwise[count - 1], { x: 4, y: 18 });
  board.zones[0].outline.reverse();
  assert.deepEqual(board, baseline);
});

test('zone and graphic preparation preserve identity, metadata, cutouts and native geometry', () => {
  for (const kind of ['zone', 'graphic'] as const) {
    const project = fixture(),
      board = project.pcb!;
    const id = kind === 'zone' ? board.zones[0].id : board.graphics[0].id;
    const next = preparePCBRegionFillet(board, { kind, id }, 2);
    assert.equal(next.footprints, board.footprints);
    assert.equal(next.tracks, board.tracks);
    assert.equal(next.vias, board.vias);
    if (kind === 'zone') {
      assert.equal(next.graphics, board.graphics);
      assert.equal(next.zones[0].holes, board.zones[0].holes);
      assert.equal(next.zones[0].priority, 7);
      assert.equal(next.zones[0].id, id);
    } else {
      assert.equal(next.zones, board.zones);
      assert.equal(next.graphics[0].id, id);
      assert.equal(next.graphics[0].fill, false);
      assert.equal(next.graphics[0].width, 0.05);
    }
    const reopened = projectFromNativeFiles(projectNativeFiles({ ...project, pcb: next })).pcb!;
    assert.equal(reopened.nets.find((net) => net.id === reopened.zones[0].netId)?.name, 'GND');
    assert.deepEqual(
      reopened.zones.map((zone) => ({ ...zone, netId: next.zones[0].netId })),
      next.zones,
    );
    assert.deepEqual(reopened.graphics, next.graphics);
  }
});

test('invalid radii, unsupported geometry, locks and cutout collisions reject without mutation', () => {
  const board = fixture().pcb!,
    target: PCBRegionTarget = { kind: 'zone', id: board.zones[0].id };
  const original = structuredClone(board);
  for (const radius of [0, -1, NaN, Infinity, 1001, 8, 20, 0.000000001])
    assert.throws(() => preparePCBRegionFillet(board, target, radius));
  assert.throws(
    () => preparePCBRegionFillet(board, { kind: 'zone', id: uid() }, 2),
    /no longer exists/,
  );
  const locked = { ...board, zones: [{ ...board.zones[0], locked: true as const }] };
  assert.throws(() => preparePCBRegionFillet(locked, target, 2), /Unlock/);
  const concave = {
    ...board,
    zones: [
      {
        ...board.zones[0],
        outline: [
          { x: 2, y: 2 },
          { x: 18, y: 2 },
          { x: 10, y: 10 },
          { x: 18, y: 18 },
          { x: 2, y: 18 },
        ],
      },
    ],
  };
  assert.throws(() => preparePCBRegionFillet(concave, target, 1), /convex/);
  const crossed = {
    ...board,
    zones: [
      {
        ...board.zones[0],
        outline: [
          { x: 2, y: 2 },
          { x: 18, y: 18 },
          { x: 18, y: 2 },
          { x: 2, y: 18 },
        ],
      },
    ],
  };
  assert.throws(() => preparePCBRegionFillet(crossed, target, 1), /self-intersections/);
  const cutout = {
    ...board,
    zones: [
      {
        ...board.zones[0],
        holes: [
          [
            { x: 2.1, y: 2.1 },
            { x: 2.2, y: 2.1 },
            { x: 2.2, y: 2.2 },
            { x: 2.1, y: 2.2 },
          ],
        ],
      },
    ],
  };
  assert.throws(() => preparePCBRegionFillet(cutout, target, 2), /cutout/);
  const line = { ...board, graphics: [{ ...board.graphics[0], kind: undefined }] };
  assert.throws(
    () => preparePCBRegionFillet(line, { kind: 'graphic', id: line.graphics[0].id }, 1),
    /polygon/,
  );
  assert.deepEqual(board, original);
});

test('region fillet bounds reject excessive geometric work', () => {
  const board = fixture().pcb!;
  board.zones[0].outline = Array.from({ length: 2100 }, (_, i) => ({
    x: 10 + 8 * Math.cos((i * 2 * Math.PI) / 2100),
    y: 10 + 8 * Math.sin((i * 2 * Math.PI) / 2100),
  }));
  assert.throws(
    () => pcbRegionFilletOutline(board, { kind: 'zone', id: board.zones[0].id }, 0.01),
    /work limit/,
  );
});

test('GUI and Agent fillets share native bytes, one undo, fill refresh and edit barriers', async () => {
  const project = fixture();
  project.pcb = fillCopperZones({
    ...project.pcb!,
    zones: [{ ...project.pcb!.zones[0], fillEnabled: true }],
  });
  const gui = new ProjectCore(project),
    agent = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, agent);
  try {
    const before = agent.getSnapshot(),
      original = agent.getNativeFiles(),
      board = before.project!.pcb!;
    const target: PCBRegionTarget = { kind: 'zone', id: board.zones[0].id };
    const args = { boardId: board.id, ...target, radius: 2 };
    gui.replaceBoard(preparePCBRegionFillet(gui.getSnapshot().project!.pcb!, target, 2));
    const result = await host.execute('layout.region.fillet', args, {
      actor: 'agent',
      expectedRevision: String(before.revision),
    });
    assert.deepEqual(result, { revision: String(agent.getSnapshot().revision) });
    assert.deepEqual(agent.getNativeFiles(), gui.getNativeFiles());
    assert.equal(agent.getSnapshot().undoDepth, 1);
    assert.notDeepEqual(
      agent.getSnapshot().project!.pcb!.zones[0].filledPolygons,
      board.zones[0].filledPolygons,
    );
    assert.ok(agent.getSnapshot().project!.pcb!.zones[0].filledPolygons);
    agent.undo();
    assert.deepEqual(agent.getNativeFiles(), original);
    await assert.rejects(
      host.execute('layout.region.fillet', args, { actor: 'agent', expectedRevision: '-1' }),
      /changed/,
    );
    agent.updateSource(agent.getSnapshot().source + '\n');
    await assert.rejects(host.execute('layout.region.fillet', args, { actor: 'agent' }), /Source/);
    agent.discardSource();
    agent.setEditingBlocked('This project is closing.');
    await assert.rejects(host.execute('layout.region.fillet', args, { actor: 'agent' }), /closing/);
  } finally {
    dispose();
    host.dispose();
  }
});
