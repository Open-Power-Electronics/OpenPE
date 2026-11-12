import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { ownProjectData } from '../lib/immutable-project';
import {
  createIncrementalPCBRoutingPartition,
  partitionPCBRoutingCopper,
} from '../lib/pcb-connectivity';
import { createPCBInteractiveDrag } from '../lib/pcb-interactive-drag';
import { preparePCBTrackAnchors } from '../lib/pcb-track-anchors';
import { createDynamicPCBRouter, createPCBRouter, createPCBRouterSession } from '../lib/pcb-routing';
import { previewConstrainedPCBTrackDrag } from '../lib/pcb-track-drag';

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function classes(partition: Map<string, string>) {
  const groups = new Map<string, string[]>();
  for (const [id, root] of partition) {
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }
  return [...groups.values()].map((ids) => ids.sort().join('\0')).sort();
}

function geometry(
  board: { tracks: { id: string; start: { x: number; y: number }; end: { x: number; y: number } }[] },
  known: ReadonlySet<string>,
) {
  return board.tracks.map((track) => [
    known.has(track.id) ? track.id : '*',
    track.start.x,
    track.start.y,
    track.end.x,
    track.end.y,
  ]);
}

test('incremental footprint clearance and partition match a full recompute on EMC Flyback', async () => {
  const project = ownProjectData(
    await projectFromNativeFiles(
      await readNativeProject('examples/project/emc-flyback/emc-flyback.kicad_pro'),
    ),
  );
  const board = project.pcb!;
  const known = new Set(board.tracks.map((track) => track.id));
  const candidates = board.footprints.filter(
    (footprint) =>
      !footprint.locked &&
      !footprint.graphics.some(
        (graphic) => graphic.layer.endsWith('.Cu') || graphic.layer === 'Edge.Cuts',
      ) &&
      !footprint.zones?.some((zone) => zone.keepout),
  );
  const roll = random(0x0e1c);
  const picked = candidates.filter(() => roll() < 0.12).slice(0, 6);
  assert.ok(picked.length >= 4, 'EMC Flyback exposes several draggable footprints.');
  for (const footprint of picked) {
    const selection = [{ kind: 'footprint' as const, id: footprint.id }];
    const engine = createPCBInteractiveDrag(board, selection, { clearance: 0.25 });
    const again = createPCBInteractiveDrag(board, selection, { clearance: 0.25 });
    for (let step = 0; step < 4; step += 1) {
      const delta = {
        x: Number(((roll() - 0.5) * 5).toFixed(3)),
        y: Number(((roll() - 0.5) * 5).toFixed(3)),
      };
      const posture = step % 2 === 0;
      const left = engine.preview(delta, posture);
      const right = again.preview(delta, posture);
      assert.equal(left.error, right.error);
      assert.deepEqual(geometry(left.board, known), geometry(right.board, known));
      const blocked = previewConstrainedPCBTrackDrag(engine, board, { x: 6, y: -4 }, posture, {
        x: 0.3,
        y: 0.1,
      });
      const repeated = previewConstrainedPCBTrackDrag(again, board, { x: 6, y: -4 }, posture, {
        x: 0.3,
        y: 0.1,
      });
      assert.equal(blocked.error, repeated.error);
      assert.deepEqual(blocked.constraint?.appliedDelta ?? null, repeated.constraint?.appliedDelta ?? null);
      assert.deepEqual(geometry(blocked.board, known), geometry(repeated.board, known));
    }
  }

  const pinned = board.footprints.find(
    (footprint) => footprint.id === 'b76c59b2-998d-4334-a859-2056b50232ca',
  );
  assert.ok(pinned, 'EMC Flyback still contains the pinned walk-around footprint.');
  const pinnedDrag = createPCBInteractiveDrag(
    board,
    [{ kind: 'footprint', id: pinned.id }],
    { clearance: 0.25 },
  );
  const pinnedPose = previewConstrainedPCBTrackDrag(
    pinnedDrag,
    board,
    { x: 8, y: 8 },
    false,
    { x: 0.5, y: 0 },
  );
  assert.deepEqual(pinnedPose.constraint?.appliedDelta, { x: 0.998047, y: 0.53125 });

  const spend = () => {};
  const anchors = preparePCBTrackAnchors(board, { limitMessage: 'limit' });
  const kept = anchors.filter((_, index) => index % 5 !== 0);
  const moved = anchors.filter((_, index) => index % 5 === 0);
  const index = createIncrementalPCBRoutingPartition(board.tracks.slice(0, 40), kept, spend);
  const full = partitionPCBRoutingCopper(
    board.tracks.slice(0, 40).concat(board.tracks.slice(40, 48)),
    kept.concat(moved),
    spend,
  );
  const incremental = index.apply(board.tracks.slice(40, 48), moved, spend);
  assert.deepEqual(classes(incremental), classes(full));

  const session = createPCBRouterSession();
  const options = {
    layer: 'F.Cu' as const,
    netId: board.nets[0].id,
    width: 0.4,
    clearance: 0.25,
  };
  const stationary = {
    ...board,
    footprints: board.footprints.slice(1),
    tracks: board.tracks.slice(0, 80),
  };
  createPCBRouter(stationary, options, session);
  const dynamic = createDynamicPCBRouter(
    { ...stationary, footprints: [board.footprints[0]], tracks: board.tracks.slice(80, 88), vias: [], graphics: [], zones: [] },
    options,
    session,
  );
  const merged = {
    ...board,
    footprints: [...board.footprints.slice(1), board.footprints[0]],
    tracks: [...board.tracks.slice(0, 80), ...board.tracks.slice(80, 88)],
  };
  const fresh = createPCBRouter(merged, options);
  const probe = [
    { x: board.footprints[0].x, y: board.footprints[0].y },
    { x: board.footprints[0].x + 2, y: board.footprints[0].y + 1 },
  ];
  assert.equal(dynamic.validate(probe), fresh.validate(probe));
  assert.deepEqual(dynamic.route(probe[0], probe[1], '45', false), fresh.route(probe[0], probe[1], '45', false));
});
