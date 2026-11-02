import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { createCapabilityHost } from '../api/capabilities';
import type { Point } from '../lib/circuit';
import type { PCB } from '../lib/pcb';
import { parseProject, projectFromNativeFiles } from '../lib/project';
import { pointSegmentDistance } from '../lib/pcb-collision';
import { previewConstrainedPCBTrackDrag } from '../lib/pcb-track-drag';
import { createPCBInteractiveTrackDrag } from '../lib/pcb-interactive-track-drag';
import { createPCBTrackChainDrag } from '../lib/pcb-track-chain-drag';
import { createEmptyPCB } from '../lib/pcb-layout';

type Span = { start: Point; end: Point; net: string; layer: string; width: number };
type Case = {
  name: string;
  trackIds: string[];
  pickup: Point;
  cursors: Point[];
  removedIds: string[];
  tracks: (Span & { originalId?: string })[];
};
const reference = JSON.parse(
  await readFile('tests/fixtures/emc-track-drag-kicad10.json', 'utf8'),
) as {
  reference: {
    sourceBoard: string;
    sourceBoardSha256: string;
    version: string;
    clearanceMM: number;
  };
  cases: Case[];
};
const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));

test('chain reshaping declines a free-angle neighbour and retains the ordinary drag planner', () => {
  const board = createEmptyPCB();
  board.nets = [{ id: 'out', name: 'OUT' }];
  const span = (id: string, start: Point, end: Point) => ({
    id,
    start,
    end,
    netId: 'out',
    layer: 'F.Cu' as const,
    width: 0.4,
  });
  board.tracks = [
    span('leader', { x: 0, y: 0 }, { x: 10, y: 0 }),
    span('free-angle', { x: 10, y: 0 }, { x: 13, y: 2 }),
  ];
  assert.equal(createPCBTrackChainDrag(board, [{ kind: 'track', id: 'leader' }], 0.25), undefined);
});
const spans = (board: PCB): Span[] =>
  board.tracks.map((t) => ({ ...t, net: board.nets.find((n) => n.id === t.netId)!.name }));
const directedDistance = (a: Span[], b: Span[]) => {
  let maximum = 0;
  for (const track of a) {
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(track.end.x - track.start.x, track.end.y - track.start.y) / 0.025),
    );
    for (let i = 0; i <= steps; i++) {
      const p = {
        x: track.start.x + ((track.end.x - track.start.x) * i) / steps,
        y: track.start.y + ((track.end.y - track.start.y) * i) / steps,
      };
      maximum = Math.max(
        maximum,
        Math.sqrt(
          Math.min(
            ...b
              .filter((t) => t.layer === track.layer && t.net === track.net)
              .map((t) => pointSegmentDistance(p, t.start, t.end)),
          ),
        ),
      );
    }
  }
  return maximum;
};

test('native KiCad drag references bind the ten cases to the unchanged EMC board', async () => {
  assert.equal(reference.reference.version, '10.0.1');
  assert.equal(reference.cases.length, 10);
  assert.equal(
    createHash('sha256')
      .update(await readFile(reference.reference.sourceBoard))
      .digest('hex'),
    reference.reference.sourceBoardSha256,
  );
});

for (const obstacleMode of ['shove', 'walk-around'] as const)
  for (const entry of reference.cases)
    test(`EMC KiCad GUI/Agent alignment: ${obstacleMode} ${entry.name}`, async () => {
      const core = new ProjectCore(project);
      const before = core.getSnapshot();
      const basis = before.project!.pcb!;
      const native = core.getNativeFiles();
      const engine = createPCBInteractiveTrackDrag(
        basis,
        entry.trackIds.map((id) => ({ kind: 'track', id })),
        {
          clearance: reference.reference.clearanceMM,
          obstacleMode,
          pickup: entry.pickup,
        },
      );
      let previous: Point | undefined;
      let result;
      for (const cursor of entry.cursors) {
        const delta = { x: cursor.x - entry.pickup.x, y: cursor.y - entry.pickup.y };
        result = previewConstrainedPCBTrackDrag(engine, basis, delta, false, previous);
        assert.equal(result.error, '');
        assert.equal(
          result.constraint,
          undefined,
          'Each native-reachable head must continue past the first obstacle.',
        );
        assert.deepEqual(
          result,
          engine.preview(delta),
          'The exact displayed proposal has stable geometry and IDs.',
        );
        assert.equal(core.getSnapshot(), before, 'Preview does not publish a transaction.');
        previous = delta;
      }
      assert.ok(result);
      const replaced = new Set([
        ...entry.removedIds,
        ...entry.tracks.flatMap((t) => (t.originalId ? [t.originalId] : [])),
      ]);
      const expected = spans({
        ...basis,
        tracks: basis.tracks.filter((t) => !replaced.has(t.id)),
      }).concat(entry.tracks);
      const keys = new Set(entry.tracks.map((t) => `${t.layer}:${t.net}`));
      const wanted = expected.filter((t) => keys.has(`${t.layer}:${t.net}`));
      const actual = spans(result.board).filter((t) => keys.has(`${t.layer}:${t.net}`));
      const deviation = Math.max(
        directedDistance(wanted, actual),
        directedDistance(actual, wanted),
      );
      assert.ok(
        deviation <= 0.01,
        `Sampled centerlines deviate ${deviation} mm from the native result.`,
      );
      assert.deepEqual(result.board.footprints, basis.footprints);
      assert.deepEqual(result.board.vias, basis.vias);
      for (const track of basis.tracks)
        assert.ok(
          result.board.tracks.some((t) => t.id === track.id),
          'Original UUIDs survive chain replanning.',
        );
      assert.equal(new Set(result.board.tracks.map((t) => t.id)).size, result.board.tracks.length);
      const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
      const dispose = registerProjectCapabilities(host, core);
      const cursor = entry.cursors.at(-1)!;
      const applied = (await host.execute(
        'layout.drag',
        {
          boardId: basis.id,
          selection: entry.trackIds.map((id) => ({ kind: 'track', id })),
          clearance: reference.reference.clearanceMM,
          pickup: entry.pickup,
          obstacleMode,
          delta: { x: cursor.x - entry.pickup.x, y: cursor.y - entry.pickup.y },
        },
        { actor: 'agent', expectedRevision: String(before.revision) },
      )) as { constrained: boolean };
      assert.equal(applied.constrained, false);
      const originals = new Set(basis.tracks.map((track) => track.id));
      const normalize = (board: PCB) =>
        board.tracks.map(({ id, ...track }) => ({
          ...track,
          id: originals.has(id) ? id : 'new',
        }));
      assert.deepEqual(
        normalize(core.getSnapshot().project!.pcb!),
        normalize(result.board),
        'Agent commits the same copper as the GUI preview, retaining original UUIDs.',
      );
      assert.equal(core.getSnapshot().undoDepth, before.undoDepth + 1);
      const nativeTracks = (board: PCB) =>
        board.tracks.map(({ netId, ...track }) => ({
          ...track,
          net: board.nets.find((net) => net.id === netId)!.name,
        }));
      assert.deepEqual(
        nativeTracks(projectFromNativeFiles(core.getNativeFiles()).pcb!),
        nativeTracks(core.getSnapshot().project!.pcb!),
      );
      core.undo();
      assert.deepEqual(
        core.getNativeFiles(),
        native,
        'Undo restores the exact original native files.',
      );
      dispose();
    });
