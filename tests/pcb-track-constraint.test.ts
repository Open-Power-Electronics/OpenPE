import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { uid, type Point } from '../lib/circuit';
import type { PCB } from '../lib/pcb';
import { ownProjectData } from '../lib/immutable-project';
import { createEmptyPCB } from '../lib/pcb-layout';
import { parseProject, serializeProject } from '../lib/project';
import { createPCBTrackJointDrag } from '../lib/pcb-track-joint-drag';
import {
  createPCBTrackDrag,
  previewConstrainedPCBTrackDrag,
  type PCBTrackDragPreview,
} from '../lib/pcb-track-drag';

const collision = 'Route blocked. Move around the obstacle or reduce the track width or clearance.';
const track = (netId: string, x1: number, y1: number, x2: number, y2: number) => ({
  id: uid(),
  netId,
  layer: 'F.Cu' as const,
  width: 0.4,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
});
function fixture() {
  const board = createEmptyPCB();
  const out = uid(),
    ground = uid();
  board.nets = [
    { id: out, name: 'OUT' },
    { id: ground, name: 'GND' },
  ];
  board.tracks = [track(out, -3, 0, 3, 0), { ...track(ground, -6, 2, 6, 2), locked: true }];
  return { board, out, ground };
}
const plan = (board: PCB, mode: 'shove' | 'walk-around' = 'shove') =>
  createPCBTrackDrag(board, [{ kind: 'track', id: board.tracks[0].id }], {
    clearance: 0.25,
    obstacleMode: mode,
  });

test('constrained previews stop at a freshly validated current-request position in either obstacle mode', () => {
  const { board: source } = fixture();
  const board = ownProjectData(source);
  for (const mode of ['shove', 'walk-around'] as const)
    for (const posture of [false, true]) {
      const engine = plan(board, mode);
      const queries: { delta: Point; posture?: boolean }[] = [];
      const counted = {
        preview(delta: Point, posture?: boolean) {
          queries.push({ delta, posture });
          return engine.preview(delta, posture);
        },
      };
      const requested = { x: 0, y: 2 };
      const result = previewConstrainedPCBTrackDrag(counted, board, requested, posture);
      assert.equal(result.error, '');
      assert.ok(result.constraint);
      assert.equal(result.constraint.basis, board);
      assert.deepEqual(result.constraint.requestedDelta, requested);
      assert.equal(result.constraint.posture, posture);
      assert.ok(result.constraint.appliedDelta.y > 1.3);
      assert.ok(result.constraint.appliedDelta.y <= 1.348);
      assert.equal(queries.length, 10, 'Requested pose, zero pose and at most eight probes.');
      assert.ok(queries.every((query) => query.posture === posture));
      const { constraint, ...exact } = result;
      assert.deepEqual(exact, engine.preview(constraint.appliedDelta, posture));
      assert.deepEqual(
        result,
        previewConstrainedPCBTrackDrag(engine, board, requested, posture),
        'Repeated rendering/placement of the same request keeps exact geometry and IDs.',
      );
      assert.deepEqual(board, source);
    }
});

test('constraint candidates depend on the current cursor rather than an earlier successful preview', () => {
  const board = ownProjectData(fixture().board);
  const warm = plan(board);
  assert.equal(warm.preview({ x: 0, y: -4 }).error, '');
  const first = previewConstrainedPCBTrackDrag(warm, board, { x: 0, y: 2 }, true);
  const cold = previewConstrainedPCBTrackDrag(plan(board), board, { x: 0, y: 2 }, true);
  assert.deepEqual(first, cold);
  const next = previewConstrainedPCBTrackDrag(warm, board, { x: 0, y: 3 }, false);
  assert.deepEqual(next, previewConstrainedPCBTrackDrag(plan(board), board, { x: 0, y: 3 }));
  assert.deepEqual(next.constraint!.requestedDelta, { x: 0, y: 3 });
  assert.equal(next.constraint!.posture, false);
});

test('a far blocked cursor cannot constrain a Shove segment through a fixed via', () => {
  const { board: source, ground } = fixture();
  source.tracks.length = 1;
  source.vias.push({ id: uid(), x: 0, y: 2, diameter: 0.8, drill: 0.3, netId: ground });
  const board = ownProjectData(source);
  const engine = plan(board);
  assert.notEqual(engine.preview({ x: 0, y: 6 }).error, '');
  const result = previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 6 });
  assert.equal(result.error, '');
  assert.ok(result.constraint);
  assert.ok(result.constraint.appliedDelta.y > 1);
  assert.ok(result.constraint.appliedDelta.y <= 1.148);
  assert.deepEqual(result.board.vias, board.vias);
  const { constraint, ...exact } = result;
  assert.deepEqual(exact, engine.preview(constraint.appliedDelta));
});

test('EMC DRV stops at its checked current-request position with two original spans and one stable reconnect', async () => {
  const project = ownProjectData(
    parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')),
  );
  const board = project.pcb!;
  const id = 'e5b79686-7bce-4eeb-bc33-cc09e12ffe67';
  const engine = createPCBTrackDrag(board, [{ kind: 'track', id }], {
    clearance: 0.25,
    obstacleMode: 'shove',
  });
  assert.equal(engine.preview({ x: -2, y: 0 }).error, collision);
  const result = previewConstrainedPCBTrackDrag(engine, board, { x: -2, y: 0 });
  assert.equal(result.error, '');
  assert.ok(result.constraint);
  assert.deepEqual(result.constraint.appliedDelta, { x: -1.429688, y: 0 });
  assert.deepEqual(result.changedIds.slice(0, 2), ['700e4418-32d4-461d-9861-0b0711185187', id]);
  assert.equal(result.changedIds.length, 3);
  assert.ok(!board.tracks.some((item) => item.id === result.changedIds[2]));
  const selected = result.board.tracks.find((item) => item.id === id)!;
  assert.deepEqual(selected.start, { x: 85.570312, y: 117.689812 });
  assert.deepEqual(selected.end, { x: 85.570312, y: 110.809688 });
  assert.deepEqual(
    result.board.tracks.slice(0, board.tracks.length).map((item) => item.id),
    board.tracks.map((item) => item.id),
  );
  assert.equal(result.board.tracks.length, board.tracks.length + 1);
  const exact = engine.preview(result.constraint.appliedDelta);
  assert.equal(exact.error, '');
  assert.deepEqual(result.board, exact.board);
  assert.equal(
    serializeProject({ ...project, pcb: result.board }),
    serializeProject({ ...project, pcb: exact.board }),
  );
  assert.equal(engine.preview({ x: -2, y: 0 }).error, collision);
});

test('constrained inherited-width spans retain the exact connected-neighbour preview', () => {
  const { board: source, out } = fixture();
  source.tracks[0].width = 0.03;
  source.tracks.push(
    { ...track(out, -3, -3, -3, 0), width: 0.03 },
    { ...track(out, 3, 0, 3, -3), width: 0.03 },
  );
  const board = ownProjectData(source);
  const engine = plan(board);
  const result = previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 2 }, true);
  assert.equal(result.error, '');
  assert.ok(result.constraint);
  const selected = result.board.tracks[0],
    left = result.board.tracks[2],
    right = result.board.tracks[3];
  assert.deepEqual(left.end, selected.start);
  assert.deepEqual(right.start, selected.end);
  assert.deepEqual(left.start, board.tracks[2].start);
  assert.deepEqual(right.end, board.tracks[3].end);
  assert.ok([selected, left, right].every((item) => item.width === 0.03));
  const { constraint, ...exact } = result;
  assert.deepEqual(exact, engine.preview(constraint.appliedDelta, true));
});

test('setup, coordinates and budget failures are never constrained', () => {
  const board = fixture().board;
  for (const error of [
    'Choose a drag clearance from 0.05 to 20 mm.',
    'Connected drag coordinates are outside the supported range.',
    'Routing exceeds the geometry limit. Use shorter waypoints or simplify the board.',
    'Track shove exceeds the geometry limit. Move fewer tracks or simplify the board.',
  ]) {
    const failed = { board, error, changedIds: [] };
    let calls = 0;
    const engine = {
      preview() {
        calls++;
        return failed;
      },
    };
    assert.equal(previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 2 }), failed);
    assert.equal(calls, 1);
  }
});

test('a far illegal cursor retains a revalidated last visible position instead of rebounding to the basis', () => {
  const board = ownProjectData(fixture().board);
  const engine = plan(board);
  const previous = { x: 0, y: 1.3 };
  assert.equal(engine.preview(previous).error, '');
  const requested = { x: 0, y: 1000 };
  const result = previewConstrainedPCBTrackDrag(engine, board, requested, false, previous);
  assert.equal(result.error, '');
  assert.deepEqual(result.constraint!.appliedDelta, previous);
  const { constraint, ...exact } = result;
  assert.deepEqual(exact, engine.preview(previous));
  assert.deepEqual(constraint!.requestedDelta, requested);
  const closer = previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 2 }, false, previous);
  assert.ok(closer.constraint!.appliedDelta.y > previous.y);
  assert.ok(closer.constraint!.appliedDelta.y <= 1.348);
  const legal = previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 1 }, false, previous);
  assert.equal(legal.constraint, undefined);
  assert.deepEqual(legal, engine.preview({ x: 0, y: 1 }));
});

test('a blocked corner turn approaches the cursor from its last visible position instead of the original ray', () => {
  const { board } = fixture();
  board.tracks[1] = { ...board.tracks[1], start: { x: -50, y: 2 }, end: { x: 50, y: 2 } };
  const seed = board.tracks[0];
  const engine = createPCBTrackJointDrag(board, seed.id, seed.end, { clearance: 0.25 });
  const previous = { x: 4, y: 0.5 };
  const requested = { x: 4, y: 2 };
  assert.equal(engine.preview(previous).error, '');
  assert.notEqual(engine.preview(requested).error, '');
  const result = previewConstrainedPCBTrackDrag(engine, board, requested, false, previous);
  assert.equal(result.error, '');
  assert.equal(result.constraint!.appliedDelta.x, 4);
  assert.ok(result.constraint!.appliedDelta.y > 1.3);
  assert.ok(result.constraint!.appliedDelta.y <= 1.348);
  assert.equal(result.board.tracks[0].end.x, seed.end.x + 4);
  assert.deepEqual(result.board.tracks[1], board.tracks[1]);
  const { constraint, ...exact } = result;
  assert.deepEqual(exact, engine.preview(constraint!.appliedDelta));
});

test('LM2596 J2 drag stops before a neighbour reverses and retains exact validated copper', async () => {
  const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
  const project = ownProjectData(parseProject(sources['reference-lm2596-to220-5-buck']));
  const board = project.pcb!;
  const id = '9f4c2ebf-c1e7-410f-91a6-9f955554ce4e';
  for (const obstacleMode of ['shove', 'walk-around'] as const) {
    const engine = createPCBTrackDrag(board, [{ kind: 'track', id }], {
      clearance: 0.25,
      obstacleMode,
    });
    const previous = { x: -2, y: 0 };
    const requested = { x: -4, y: 0 };
    assert.equal(engine.preview(previous).error, '');
    assert.match(engine.preview(requested).error, /collapse|reverse/);
    const result = previewConstrainedPCBTrackDrag(engine, board, requested, false, previous);
    assert.equal(result.error, '');
    assert.ok(result.constraint!.appliedDelta.x < -2);
    assert.ok(result.constraint!.appliedDelta.x > -4);
    assert.notEqual(result.board, board);
    const { constraint, ...exact } = result;
    assert.deepEqual(exact, engine.preview(constraint!.appliedDelta));
    assert.deepEqual(result.board.footprints, board.footprints);
    assert.deepEqual(result.board.vias, board.vias);
  }
});

test('interactive geometry failures are bounded by fresh checks, including collapse and lost contacts', () => {
  const board = fixture().board;
  for (const error of [
    'Connected drag would collapse or reverse a track. Move less or choose another direction.',
    'Connected drag would collapse an attached track. Move less or choose another direction.',
    'Connected drag would lose a fixed terminal contact. Move less or choose another direction.',
    'Track shove would collapse a track. Move less or choose another direction.',
    'Track shove would remove a copper connection. Move less.',
    'Track shove would change copper connectivity. Move less or choose another direction.',
    'Track corner drag would collapse a segment. Move away from the adjoining endpoint.',
  ]) {
    const engine = {
      preview(delta: Point): PCBTrackDragPreview {
        return delta.y < 1
          ? {
              board: delta.y ? { ...board, tracks: [] } : board,
              changedIds: delta.y ? [board.tracks[0].id] : [],
              error: '',
            }
          : { board, error, changedIds: [] };
      },
    };
    const result = previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 2 });
    assert.equal(result.error, '');
    assert.ok(result.constraint!.appliedDelta.y > 0.99);
    assert.ok(result.constraint!.appliedDelta.y < 1);
    const { constraint, ...exact } = result;
    assert.deepEqual(exact, engine.preview(constraint!.appliedDelta));
  }
});

test('the last displacement is rechecked, never reused as a cached board under changed constraints', () => {
  const board = ownProjectData(fixture().board);
  const engine = plan(board);
  const result = previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 2 }, false, {
    x: 0,
    y: 1.9,
  });
  assert.equal(result.error, '');
  assert.ok(result.constraint!.appliedDelta.y <= 1.348);
  const failed = {
    board,
    error: 'Routing exceeds the geometry limit. Use shorter waypoints or simplify the board.',
    changedIds: [],
  };
  assert.equal(
    previewConstrainedPCBTrackDrag({ preview: () => failed }, board, { x: 0, y: 2 }, false, {
      x: 0,
      y: 1,
    }),
    failed,
  );
});

test('different basis, a noncollision probe failure and absence of nonzero legal geometry keep the request blocked', () => {
  const board = fixture().board;
  const blocked = { board, error: collision, changedIds: [] };
  for (const scenario of ['basis', 'budget', 'zero']) {
    let calls = 0;
    const engine = {
      preview(delta: Point): PCBTrackDragPreview {
        calls++;
        if (delta.y === 2) return blocked;
        if (!delta.y)
          return {
            board: scenario === 'basis' ? { ...board } : board,
            error: '',
            changedIds: [],
          };
        return {
          board,
          error:
            scenario === 'budget'
              ? 'Routing exceeds the geometry limit. Use shorter waypoints or simplify the board.'
              : '',
          changedIds: [],
        };
      },
    };
    assert.equal(previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 2 }), blocked);
    assert.ok(calls <= 10);
    if (scenario === 'basis') assert.equal(calls, 2);
  }
});

test('nonmonotone legality still returns only an individually validated current-ray candidate', () => {
  const board = fixture().board;
  const queries: number[] = [];
  const engine = {
    preview(delta: Point): PCBTrackDragPreview {
      queries.push(delta.y);
      const legal = delta.y <= 0.4 || (delta.y >= 0.8 && delta.y <= 0.9);
      return legal
        ? {
            board: delta.y ? { ...board, tracks: [] } : board,
            changedIds: delta.y ? [board.tracks[0].id] : [],
            error: '',
          }
        : { board, changedIds: [], error: collision };
    },
  };
  const result = previewConstrainedPCBTrackDrag(engine, board, { x: 0, y: 1 });
  assert.equal(result.error, '');
  assert.ok(result.constraint);
  assert.ok(result.constraint.appliedDelta.y <= 0.4);
  assert.ok(queries.includes(result.constraint.appliedDelta.y));
  assert.equal(queries.length, 10);
});
