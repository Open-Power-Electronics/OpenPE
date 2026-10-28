import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { uid, type Point } from '../lib/circuit';
import type { Footprint, PCB } from '../lib/pcb';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { createEmptyPCB, type PCBSelection } from '../lib/pcb-layout';
import { createPCBRouter } from '../lib/pcb-routing';
import { createPCBTrackDrag } from '../lib/pcb-track-drag';
import { expandPCBTrackSelection } from '../lib/pcb-track-selection';
import { createProject, parseProject, serializeProject } from '../lib/project';
import { ownProjectData } from '../lib/immutable-project';
import type { PCBTrackDragPreview } from '../lib/pcb-track-drag';
import { createPCBTrackShove } from '../lib/pcb-track-shove';
import { preparePCBTrackAnchors } from '../lib/pcb-track-anchors';
import { insidePolygon, polygonEdges, segmentDistance } from '../lib/pcb-collision';
import type { Polygon } from '../lib/pcb-polygons';

const clearance = 0.25;
type Track = PCB['tracks'][number];
const track = (netId: string, x1: number, y1: number, x2: number, y2: number): Track => ({
  id: uid(),
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  width: 0.4,
  layer: 'F.Cu',
  netId,
});
function fixture() {
  const board = createEmptyPCB();
  const [out, ground, auxiliary] = [uid(), uid(), uid()];
  board.nets = [
    { id: out, name: 'OUT' },
    { id: ground, name: 'GND' },
    { id: auxiliary, name: 'AUX' },
  ];
  board.tracks = [track(out, -3, 0, 3, 0), track(ground, -6, 2, 6, 2)];
  const selected: PCBSelection[] = [{ kind: 'track', id: board.tracks[0].id }];
  return { board, selected, out, ground, auxiliary };
}
function assertClearance(board: PCB) {
  for (const item of board.tracks) {
    assert.ok(
      Math.hypot(item.end.x - item.start.x, item.end.y - item.start.y) > 0.000001,
      'Successful shove proposals must not introduce zero-length tracks.',
    );
    assert.equal(
      createPCBRouter(board, {
        layer: item.layer,
        netId: item.netId,
        width: item.width,
        clearance,
        allowInheritedWidth: true,
      }).validate([item.start, item.end]),
      '',
      `Track ${item.id} must retain physical clearance after the complete shove.`,
    );
  }
}
function footprint(netId: string, x: number, y: number): Footprint {
  return {
    id: uid(),
    symbolId: null,
    libraryId: 'Test:ShoveAnchor',
    x,
    y,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'circle',
        size: { x: 0.8, y: 0.8 },
        netId,
        layers: ['F.Cu'],
      },
    ],
  };
}
const shove = (board: PCB, selection: PCBSelection[]) =>
  createPCBTrackDrag(board, selection, { clearance, obstacleMode: 'shove' });

test('shove moves neighbouring foreign copper around the selected target while retaining its terminals', () => {
  const { board, selected, ground } = fixture();
  const before = structuredClone(board);
  const result = shove(board, selected).preview({ x: 0, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[0], {
    ...board.tracks[0],
    start: { x: -3, y: 2 },
    end: { x: 3, y: 2 },
  });
  assert.notDeepEqual(result.board.tracks[1], board.tracks[1]);
  const foreign = result.board.tracks.filter((item) => item.netId === ground);
  assert.ok(foreign.length > 1, 'The original crossing span needs a genuine copper detour.');
  for (const endpoint of [board.tracks[1].start, board.tracks[1].end])
    assert.ok(
      foreign.some((item) => [item.start, item.end].some((point) => assertPoint(point, endpoint))),
      'The original remote terminal stays fixed.',
    );
  assert.ok(result.changedIds.includes(board.tracks[1].id));
  assertClearance(result.board);
  assert.deepEqual(board, before);
});

function assertPoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.abs(a.x - b.x) < 0.000001 && Math.abs(a.y - b.y) < 0.000001;
}

function equivalentPreview(result: PCBTrackDragPreview, original: PCB) {
  const ids = new Set(original.tracks.map((item) => item.id));
  const generated = new Map(
    result.board.tracks
      .filter((item) => !ids.has(item.id))
      .map((item, index) => [item.id, `generated:${index}`]),
  );
  const id = (value: string) => generated.get(value) ?? value;
  return {
    error: result.error,
    changedIds: result.changedIds.map(id),
    board: {
      ...result.board,
      tracks: result.board.tracks.map((item) => ({ ...item, id: id(item.id) })),
    },
  };
}

test('warm EMC shove partitions and routers preserve exact repeated poses and native Source', async () => {
  const project = ownProjectData(
    parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')),
  );
  const board = project.pcb!;
  const selected: PCBSelection[] = [{ kind: 'track', id: '55e76c6c-a882-41a3-85b9-455b1a2d200e' }];
  const before = serializeProject(project);
  const plan = shove(board, selected);
  const checkedSources = new Set<number>();
  for (const y of [0.5, -0.5, 0.1, 0.25, -0.25, 0.5, -0.5, 0])
    for (const posture of [false, true]) {
      const actual = plan.preview({ x: 0, y }, posture);
      const cold = shove(board, selected).preview({ x: 0, y }, posture);
      assert.equal(actual.error, '');
      assert.deepEqual(actual, cold);
      if (Math.abs(y) === 0.5 && !checkedSources.has(y)) {
        const copied = shove(structuredClone(board), selected).preview({ x: 0, y }, posture);
        assert.deepEqual(
          equivalentPreview(actual, board),
          equivalentPreview(copied, board),
          'Owned private contacts match the independent public-copy preparation.',
        );
        assert.equal(
          serializeProject({ ...project, pcb: actual.board }),
          serializeProject({ ...project, pcb: cold.board }),
        );
        checkedSources.add(y);
      }
    }
  assert.equal(serializeProject(project), before);
});

test('shove connectivity agrees with exhaustive copper contacts across drilled and rotated shapes', () => {
  // Exhaustive vertices and edge pairs provide an independent reference for
  // containment/crossing, drill holes, copper radii and cross-layer bridges.
  // The supplied rigid planner isolates Shove's connectivity gate from routing.
  const groups = (board: PCB) => {
    type Contact = {
      id: string;
      points: Point[];
      edges: [Point, Point][];
      layers: string[];
      radius: number;
      polygon?: Polygon;
    };
    const bodies: Contact[] = board.tracks.map((item) => ({
      id: item.id,
      points: [item.start, item.end],
      edges: [[item.start, item.end]],
      layers: [item.layer],
      radius: item.width / 2,
    }));
    for (const anchor of preparePCBTrackAnchors(board, { limitMessage: 'Unexpected test limit.' }))
      bodies.push({
        id: anchor.id,
        points: anchor.polygon.outer,
        edges: polygonEdges(anchor.polygon),
        layers: anchor.layers,
        radius: 0,
        polygon: anchor.polygon,
      });
    const parents = bodies.map((_, index) => index);
    const find = (index: number): number =>
      parents[index] === index ? index : (parents[index] = find(parents[index]));
    for (let first = 0; first < bodies.length; first++)
      for (let second = first + 1; second < bodies.length; second++) {
        const a = bodies[first],
          b = bodies[second];
        if (!a.layers.some((layer) => b.layers.includes(layer))) continue;
        if (
          (a.polygon && b.points.some((point) => insidePolygon(point, a.polygon!))) ||
          (b.polygon && a.points.some((point) => insidePolygon(point, b.polygon!))) ||
          a.edges.some(([p, q]) =>
            b.edges.some(
              ([r, s]) => segmentDistance(p, q, r, s) <= (a.radius + b.radius + 0.000001) ** 2,
            ),
          )
        )
          parents[find(second)] = find(first);
      }
    return bodies.map((_, index) => find(index));
  };
  const shapes = ['rect', 'circle', 'oval', 'roundrect'] as const;
  for (let sample = 0; sample < 24; sample++) {
    const { board, out } = fixture();
    board.tracks = [
      track(out, -4, -4, 4, -4),
      track(out, -3, 0, 3, 0),
      { ...track(out, 0, -2, 0, 2), layer: 'B.Cu' },
      track(out, 2, 2, 2, 2),
    ];
    board.footprints = Array.from({ length: 3 }, (_, index) => {
      const f = footprint(out, index - 1, (sample % 5) / 4);
      f.rotation = ((sample + index) % 8) * 45;
      const pad = f.pads[0];
      pad.shape = shapes[(sample + index) % shapes.length];
      pad.size = { x: 1.4 + index * 0.4, y: 1.4 + (index % 2) * 0.8 };
      pad.rotation = sample % 2 ? 25 : 0;
      pad.roundrectRatio = 0.25;
      if (index === 1) {
        pad.type = 'thru_hole';
        pad.layers = ['*.Cu'];
        pad.drill = 0.9;
        pad.drillOffset = { x: 0.15, y: 0 };
      }
      return f;
    });
    board.vias = [{ id: uid(), x: 0, y: 0, diameter: 3, drill: 2, netId: out }];
    const original = groups(board);
    const selected: PCBSelection[] = [{ kind: 'track', id: board.tracks[0].id }];
    const plan = createPCBTrackShove(ownProjectData(board), selected, clearance, (basis) => ({
      preview(delta) {
        return {
          board: {
            ...basis,
            tracks: basis.tracks.map((item, index) =>
              index
                ? item
                : {
                    ...item,
                    start: { x: item.start.x, y: item.start.y + delta.y },
                    end: { x: item.end.x, y: item.end.y + delta.y },
                  },
            ),
          },
          changedIds: [basis.tracks[0].id],
          error: '',
        };
      },
    }));
    for (const y of [0.5, 2, 3, 4, 5, 6]) {
      const moved = structuredClone(board);
      moved.tracks[0].start.y += y;
      moved.tracks[0].end.y += y;
      const after = groups(moved);
      const preserved = original.every((group, first) =>
        original.every((other, second) => (group === other) === (after[first] === after[second])),
      );
      const result = plan.preview({ x: 0, y });
      assert.equal(result.error === '', preserved, `Copper contact sample ${sample}, delta ${y}.`);
      if (result.error) {
        assert.match(result.error, /change copper connectivity/);
        assert.deepEqual(result.changedIds, []);
      } else assert.deepEqual(result.board.tracks, moved.tracks);
    }
  }
});

test('warm shove checks every moved foreign pose and changing stationary contact set against cold engines', () => {
  const data = fixture();
  data.board.tracks.push(track(data.auxiliary, -8, 2.8, 8, 2.8));
  const board = ownProjectData(data.board);
  const plan = shove(board, data.selected);
  for (const y of [-0.5, 0.5, 2, 3, 6, 2, -0.5, 0])
    for (const posture of [false, true]) {
      const actual = plan.preview({ x: 0, y }, posture);
      const cold = shove(board, data.selected).preview({ x: 0, y }, posture);
      assert.deepEqual(equivalentPreview(actual, board), equivalentPreview(cold, board));
      assert.equal(actual.error, '');
      assertClearance(actual.board);
      if (y === 2 || y === 6) assert.ok(actual.changedIds.includes(board.tracks[1].id));
    }
  const escaped = plan.preview({ x: 0, y: 2 });
  escaped.board.tracks.find((item) => item.id === board.tracks[1].id)!.start.x = 2000;
  assert.deepEqual(
    equivalentPreview(plan.preview({ x: 0, y: 2 }), board),
    equivalentPreview(shove(board, data.selected).preview({ x: 0, y: 2 }), board),
    'A previously returned moved track cannot poison a retained obstacle router.',
  );
});

test('sparse multilayer shove partitions retain the X broad phase before spending geometry budget', () => {
  const { board, out, ground } = fixture();
  board.tracks = Array.from({ length: 200 }, (_, index) =>
    track(out, index * 4, 0, index * 4 + 1, 0),
  ).concat(
    Array.from({ length: 14000 }, (_, index) => ({
      ...track(ground, 10000 + index * 4, 0, 10001 + index * 4, 0),
      layer: 'B.Cu',
    })),
  );
  const owned = ownProjectData(board);
  const selected: PCBSelection[] = owned.tracks
    .slice(0, 200)
    .map((item) => ({ kind: 'track', id: item.id }));
  // Supply the already-prepared rigid group to isolate Shove's partition
  // budget from the connected planner's separate preparation budget.
  const plan = createPCBTrackShove(owned, selected, clearance, (basis) => ({
    preview: (delta) => ({
      board: {
        ...basis,
        tracks: basis.tracks.map((item, index) =>
          index < 200
            ? {
                ...item,
                start: { x: item.start.x, y: item.start.y + delta.y },
                end: { x: item.end.x, y: item.end.y + delta.y },
              }
            : item,
        ),
      },
      error: '',
      changedIds: selected.map((item) => item.id),
    }),
  }));
  for (const y of [0.5, -0.5, 0.5]) {
    const result = plan.preview({ x: 0, y });
    assert.equal(result.error, '');
    assert.equal(result.changedIds.length, 200);
    assert.equal(result.board.tracks.length, 14200);
    assert.deepEqual(result.board.tracks.slice(200), owned.tracks.slice(200));
  }
});

test('sparse final Shove checks skip distant copper while dense checks preserve budget failures', () => {
  for (const dense of [false, true]) {
    const { board, out, ground } = fixture();
    board.tracks = Array.from({ length: 150 }, (_, index) =>
      track(out, index * 4, 0, index * 4 + 1, 0),
    ).concat(
      Array.from({ length: 14000 }, (_, index) => ({
        ...track(ground, 10000 + index * 4, 10, 10001 + index * 4, 10),
        locked: true,
      })),
    );
    if (dense) {
      // Overlapping bounds require exact distance work in every final span.
      // Copper graphics avoid exhausting an unrelated track-contact partition.
      board.tracks = board.tracks.slice(0, 150);
      board.graphics = Array.from({ length: 14000 }, () => ({
        id: uid(),
        layer: 'F.Cu',
        width: 0.4,
        start: { x: -10000, y: -9990 },
        end: { x: 10000, y: 10010 },
      }));
    }
    const owned = ownProjectData(board);
    const selected: PCBSelection[] = [{ kind: 'track', id: owned.tracks[0].id }];
    // Isolate the final whole-proposal collision budget. One selected spine has
    // many prepared attached spans, but only that spine contributes a sweep.
    const engine = createPCBTrackShove(owned, selected, clearance, (basis) => ({
      preview: (delta) => ({
        board: {
          ...basis,
          tracks: basis.tracks.map((item, index) =>
            index < 150
              ? {
                  ...item,
                  start: { x: item.start.x, y: item.start.y + delta.y },
                  end: { x: item.end.x, y: item.end.y + delta.y },
                }
              : item,
          ),
        },
        changedIds: basis.tracks.slice(0, 150).map((item) => item.id),
        error: '',
      }),
    }));
    const result = engine.preview({ x: 0, y: 1 });
    if (!dense) {
      assert.equal(result.error, '');
      assert.equal(result.changedIds.length, 150);
      assert.deepEqual(result.board.tracks.slice(150), owned.tracks.slice(150));
      continue;
    }
    assert.match(result.error, /geometry limit/);
    assert.equal(result.board, owned);
    assert.deepEqual(result.changedIds, []);
  }
});

test('caller mutation, including shallow-frozen inputs and escaped previews, rebuilds shove preparation', () => {
  for (const frozen of [false, true]) {
    const { board, selected, ground } = fixture();
    board.tracks[1].locked = true;
    board.footprints.push(footprint(ground, 20, 20));
    board.vias.push({ id: uid(), x: 20, y: 20, diameter: 0.8, drill: 0.3, netId: ground });
    board.graphics.push({
      id: uid(),
      kind: 'text',
      layer: 'F.Cu',
      start: { x: 20, y: 20 },
      end: { x: 20, y: 20 },
      width: 0,
      text: { value: 'Copper', size: { x: 1, y: 1 }, thickness: 0.1, rotation: 0 },
    });
    if (frozen) Object.freeze(board);
    const plan = shove(board, selected);
    const compare = () => {
      const actual = plan.preview({ x: 0, y: 1 });
      const cold = shove(structuredClone(board), selected).preview({ x: 0, y: 1 });
      assert.deepEqual(equivalentPreview(actual, board), equivalentPreview(cold, board));
      return actual;
    };
    assert.equal(compare().error, '');
    // This is an unchanged record shared by the public preview and input.
    const escaped = compare().board.tracks[1];
    escaped.start.y = escaped.end.y = 1;
    assert.notEqual(compare().error, '', 'The changed locked obstacle must be checked.');
    escaped.start.y = escaped.end.y = 2;
    assert.equal(compare().error, '');
    for (const obstacle of ['pad', 'via', 'artwork']) {
      const point =
        obstacle === 'pad'
          ? board.footprints[0]
          : obstacle === 'via'
            ? board.vias[0]
            : board.graphics[0].start;
      point.x = 0;
      point.y = 1;
      assert.notEqual(compare().error, '', `${obstacle} mutation invalidates fixed geometry.`);
      point.x = point.y = 20;
      assert.equal(compare().error, '');
    }
  }
});

test('a shove cascades into another net and validates the complete displaced geometry', () => {
  const { board, selected, auxiliary } = fixture();
  board.tracks.push(track(auxiliary, -8, 2.8, 8, 2.8));
  const before = structuredClone(board);
  const result = shove(board, selected).preview({ x: 0, y: 2 });
  assert.equal(result.error, '');
  for (const original of board.tracks.slice(1)) {
    assert.ok(result.changedIds.includes(original.id));
    assert.notDeepEqual(
      result.board.tracks.find((item) => item.id === original.id),
      original,
    );
  }
  assertClearance(result.board);
  assert.deepEqual(board, before);
});

test('a large shove retains the original side of an overtaken neighbouring trace', () => {
  const { board, selected, ground } = fixture();
  const before = structuredClone(board);
  const result = shove(board, selected).preview({ x: 0, y: 6 });
  assert.equal(result.error, '');
  const foreign = result.board.tracks.filter((item) => item.netId === ground);
  assert.ok(result.changedIds.includes(board.tracks[1].id));
  assert.ok(
    Math.max(...foreign.flatMap((item) => [item.start.y, item.end.y])) >= 6.65,
    'The trace that started above the selection is pushed ahead of it even when the final pointer has passed it.',
  );
  assertClearance(result.board);
  assert.deepEqual(board, before);
});

test('a diagonal slide pushes floating neighbours perpendicular to the track rather than along its sliding joint', () => {
  const { board, out, ground } = fixture();
  board.tracks = [
    track(out, -10, 0, 0, 0),
    track(out, 0, 0, 10, 10),
    track(out, 10, 10, 10, 20),
    track(ground, 2.5, 3.5, 3.5, 4.5),
  ];
  const before = structuredClone(board);
  const result = shove(board, [{ kind: 'track', id: board.tracks[1].id }]).preview({ x: -2, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.tracks[1].start, { x: -4, y: 0 });
  assert.deepEqual(result.board.tracks[1].end, { x: 10, y: 14 });
  const neighbour = result.board.tracks.find((item) => item.id === board.tracks[3].id)!;
  for (const endpoint of ['start', 'end'] as const) {
    assert.ok(neighbour[endpoint].y - neighbour[endpoint].x >= 4.9);
    assert.ok(
      Math.abs(
        neighbour[endpoint].x +
          neighbour[endpoint].y -
          before.tracks[3][endpoint].x -
          before.tracks[3][endpoint].y,
      ) < 0.00001,
    );
  }
  assertClearance(result.board);
  assert.deepEqual(board, before);
});

test('equal-span neighbouring traces shove as one unbranched chain while remote terminals remain fixed', () => {
  const { board, selected, ground } = fixture();
  board.tracks = [
    board.tracks[0],
    track(ground, -6, 5, -3, 2),
    track(ground, -3, 2, 3, 2),
    track(ground, 3, 2, 6, 5),
  ];
  const before = structuredClone(board);
  const originalIds = board.tracks.map((item) => item.id);
  const result = shove(board, selected).preview({ x: 0, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(
    result.board.tracks.slice(0, originalIds.length).map((item) => item.id),
    originalIds,
  );
  const foreign = result.board.tracks.filter((item) => item.netId === ground);
  for (const endpoint of [board.tracks[1].start, board.tracks[3].end])
    assert.ok(
      foreign.some((item) => [item.start, item.end].some((point) => assertPoint(point, endpoint))),
    );
  const connectedIds = expandPCBTrackSelection(
    result.board,
    [{ kind: 'track', id: originalIds[1] }],
    defaultPCBDisplay(),
    { footprint: true, track: true, via: true, graphic: true, zone: true },
    'connected',
  ).map((item) => item.id);
  for (const id of originalIds.slice(1)) assert.ok(connectedIds.includes(id));
  assertClearance(result.board);
  assert.deepEqual(board, before);
});

test('a shorter floating neighbouring trace moves ahead of the selection without artificial fixed endpoints', () => {
  const { board, selected, ground } = fixture();
  board.tracks[1] = track(ground, -2, 2, 2, 2);
  const before = structuredClone(board);
  const plan = shove(board, selected);
  const result = plan.preview({ x: 0, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result, plan.preview({ x: 0, y: 2 }));
  const neighbour = result.board.tracks.find((item) => item.id === board.tracks[1].id);
  assert.ok(neighbour);
  assert.ok(result.changedIds.includes(neighbour.id));
  assert.equal(neighbour.width, board.tracks[1].width);
  assert.equal(neighbour.netId, ground);
  assert.ok(neighbour.start.y >= 2.65 && neighbour.end.y >= 2.65);
  assertClearance(result.board);
  assert.deepEqual(board, before);
});

test('shove cannot silently join a previously disconnected same-net copper island', () => {
  const { board, selected, ground } = fixture();
  const island = track(ground, -1, 2.8, 1, 2.8);
  board.tracks.push(island);
  const before = structuredClone(board);
  const connectedIds = (basis: PCB) =>
    expandPCBTrackSelection(
      basis,
      [{ kind: 'track', id: board.tracks[1].id }],
      defaultPCBDisplay(),
      { footprint: true, track: true, via: true, graphic: true, zone: true },
      'connected',
    ).map((item) => item.id);
  assert.ok(!connectedIds(board).includes(island.id));
  const result = shove(board, selected).preview({ x: 0, y: 2 });
  if (result.error) {
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
  } else {
    assert.ok(!connectedIds(result.board).includes(island.id));
    assertClearance(result.board);
  }
  assert.deepEqual(board, before);
});

test('shoved tracks retain remote pad, via and interior branch contacts without moving those anchors', () => {
  const { board, selected, ground } = fixture();
  board.footprints = [footprint(ground, -6, 2), footprint(ground, 6, 2)];
  board.vias = [{ id: uid(), x: 6, y: 2, diameter: 0.8, drill: 0.3, netId: ground }];
  const branch = track(ground, 5, 2, 5, 5);
  board.tracks.push(branch);
  board.footprints.push(footprint(ground, 5, 5));
  const before = structuredClone(board);
  const result = shove(board, selected).preview({ x: 0, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result.board.footprints, board.footprints);
  assert.deepEqual(result.board.vias, board.vias);
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === branch.id),
    branch,
  );
  assert.equal(analyzePCBConnectivity(result.board).edges.length, 0);
  const connectedIds = expandPCBTrackSelection(
    result.board,
    [{ kind: 'track', id: board.tracks[1].id }],
    defaultPCBDisplay(),
    { footprint: true, track: true, via: true, graphic: true, zone: true },
    'connected',
  ).map((item) => item.id);
  assert.ok(connectedIds.includes(branch.id));
  assertClearance(result.board);
  assert.deepEqual(board, before);
});

test('shove retains original identities, source order, widths and stable new IDs across previews and roundtrip', () => {
  const { board, selected, out, ground } = fixture();
  board.tracks[1].width = 0.6;
  const back = { ...track(ground, -4, 2, 4, 2), layer: 'B.Cu' as const };
  const island = track(out, 20, 20, 24, 20);
  board.tracks.push(back, island);
  const originalIds = board.tracks.map((item) => item.id);
  const plan = shove(board, selected);
  const result = plan.preview({ x: 0, y: 2 });
  assert.equal(result.error, '');
  assert.deepEqual(result, plan.preview({ x: 0, y: 2 }));
  assert.deepEqual(
    result.board.tracks.slice(0, originalIds.length).map((item) => item.id),
    originalIds,
  );
  assert.equal(
    new Set(result.board.tracks.map((item) => item.id)).size,
    result.board.tracks.length,
  );
  for (const item of result.board.tracks.filter(
    (item) => item.netId === ground && item.layer === 'F.Cu',
  ))
    assert.equal(item.width, 0.6);
  for (const original of [back, island])
    assert.deepEqual(
      result.board.tracks.find((item) => item.id === original.id),
      original,
    );
  assertClearance(result.board);
  assert.deepEqual(
    parseProject(serializeProject({ ...createProject(), pcb: result.board })).pcb,
    result.board,
  );
});

test('every board layer participates in shove checks independent of presentation visibility', () => {
  const { board, selected, ground } = fixture();
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  board.tracks = board.tracks.map((item) => ({ ...item, layer: 'In1.Cu' }));
  const unrelated = { ...track(ground, -4, 2, 4, 2), layer: 'In2.Cu' as const };
  board.tracks.push(unrelated);
  const result = shove(board, selected).preview({ x: 0, y: 2 });
  assert.equal(result.error, '');
  assert.ok(result.changedIds.includes(board.tracks[1].id));
  assert.deepEqual(
    result.board.tracks.find((item) => item.id === unrelated.id),
    unrelated,
  );
  assertClearance(result.board);
});

test('fixed copper anchors and track keepouts block atomically after a prior successful preview', () => {
  for (const kind of ['pad', 'via', 'branch', 'keepout']) {
    const { board, selected, ground } = fixture();
    if (kind === 'pad') board.footprints = [footprint(ground, 0, 2)];
    if (kind === 'via')
      board.vias = [{ id: uid(), x: 0, y: 2, diameter: 0.8, drill: 0.3, netId: ground }];
    if (kind === 'branch') board.tracks.push(track(ground, 0, 2, 0, 5));
    if (kind === 'keepout')
      board.zones = [
        {
          id: uid(),
          netId: null,
          layer: 'F.Cu',
          outline: [
            { x: -4, y: 1 },
            { x: 4, y: 1 },
            { x: 4, y: 3 },
            { x: -4, y: 3 },
          ],
          clearance,
          minThickness: 0.2,
          thermalGap: 0.3,
          thermalBridge: 0.3,
          keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
        },
      ];
    const before = structuredClone(board);
    const plan = shove(board, selected);
    assert.equal(plan.preview({ x: 0, y: -1 }).error, '');
    const result = plan.preview({ x: 0, y: 2 });
    assert.notEqual(result.error, '', `${kind} cannot be shoved away from its fixed contact.`);
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
    assert.deepEqual(board, before);
  }
});

test('locked foreign tracks remain fixed obstacles instead of entering a shove chain', () => {
  const { board, selected } = fixture();
  board.tracks[1] = { ...board.tracks[1], locked: true };
  const before = structuredClone(board),
    plan = shove(board, selected);
  assert.equal(plan.preview({ x: 0, y: -1 }).error, '');
  const result = plan.preview({ x: 0, y: 2 });
  assert.match(result.error, /blocked/);
  assert.equal(result.board, board);
  assert.deepEqual(result.changedIds, []);
  assert.deepEqual(board, before);
});

test('a long pointer step cannot leap over fixed vias, pads or keepouts despite a clear final track', () => {
  for (const kind of ['via', 'pad', 'keepout']) {
    const { board, selected, ground } = fixture();
    board.tracks = [board.tracks[0]];
    if (kind === 'via')
      board.vias = [{ id: uid(), x: 0, y: 2, diameter: 0.8, drill: 0.3, netId: ground }];
    if (kind === 'pad') board.footprints = [footprint(ground, 0, 2)];
    if (kind === 'keepout')
      board.zones = [
        {
          id: uid(),
          netId: null,
          layer: 'F.Cu',
          outline: [
            { x: -1, y: 1.5 },
            { x: 1, y: 1.5 },
            { x: 1, y: 2.5 },
            { x: -1, y: 2.5 },
          ],
          clearance,
          minThickness: 0.2,
          thermalGap: 0.3,
          thermalBridge: 0.3,
          keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
        },
      ];
    const before = structuredClone(board);
    const plan = shove(board, selected);
    assert.equal(plan.preview({ x: 0, y: -1 }).error, '');
    const result = plan.preview({ x: 0, y: 4 });
    assert.notEqual(result.error, '', `The swept track crosses the fixed ${kind}.`);
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
    assert.deepEqual(board, before);
  }
});

test('shove rejects an oversized selected group before planning or changing any copper', () => {
  const { board, out } = fixture();
  board.tracks = Array.from({ length: 257 }, (_, index) => track(out, -3, index * 2, 3, index * 2));
  const selected: PCBSelection[] = board.tracks.map((item) => ({ kind: 'track', id: item.id }));
  const before = structuredClone(board);
  const result = shove(board, selected).preview({ x: 0, y: 1 });
  assert.match(result.error, /geometry limit/);
  assert.equal(result.board, board);
  assert.deepEqual(result.changedIds, []);
  assert.deepEqual(board, before);
});

test('zero and parallel movement stay clean; explicit Walk Around and the library default retain fixed foreign tracks', () => {
  const { board, selected } = fixture();
  const plan = shove(board, selected);
  for (const delta of [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
  ])
    assert.deepEqual(plan.preview(delta), { board, error: '', changedIds: [] });
  for (const options of [{ clearance }, { clearance, obstacleMode: 'walk-around' as const }]) {
    const result = createPCBTrackDrag(board, selected, options).preview({ x: 0, y: 2 });
    assert.notEqual(result.error, '');
    assert.equal(result.board, board);
    assert.deepEqual(result.changedIds, []);
  }
});
