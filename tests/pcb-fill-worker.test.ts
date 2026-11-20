import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPCBFillWorkerProcessor,
  type PCBFillWorkerRequest,
  type PCBFillWorkerResponse,
} from '../components/pcbFillWorkerProtocol';
import { uid, type Point } from '../lib/circuit';
import { createEmptyPCB, movePCBSelection } from '../lib/pcb-layout';
import { invalidatePCBFill, type PCB } from '../lib/pcb';
import { filledCopperPolygons, fillCopperZones, type Polygon } from '../lib/pcb-polygons';
import { createProject, exportKiCad } from '../lib/project';
import { child, children, parseSExpr, val } from '../lib/sexpr';

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
      outline: corners,
      clearance: 0.3,
      minThickness: 0.1,
      thermalGap: 0.3,
      thermalBridge: 0.3,
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
  return fillCopperZones(board);
}

function filled(response: PCBFillWorkerResponse | undefined) {
  assert.ok(response);
  assert.equal(response.error, undefined);
  assert.ok(response.board);
  assert.ok(response.paths);
  return { board: response.board, paths: response.paths };
}

function insideRing(points: Point[], point: Point) {
  let result = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}
const contains = (polygons: Polygon[], point: Point) =>
  polygons.some(
    (polygon) =>
      insideRing(polygon.outer, point) && !polygon.holes.some((hole) => insideRing(hole, point)),
  );

test('worker results refill one current route gap and persist inherited native clearance without a ghost gap', () => {
  const basis = fixture();
  basis.zones[0].clearance = 0;
  const before = structuredClone(basis);
  const process = createPCBFillWorkerProcessor();
  assert.equal(process({ type: 'basis', generation: 1, board: basis }), undefined);
  const moved = movePCBSelection(basis, { kind: 'track', id: basis.tracks[0].id }, { x: 0, y: 3 });
  const response = process({
    type: 'fill',
    generation: 1,
    requestId: 2,
    board: invalidatePCBFill(basis, moved),
  });
  const result = filled(response);
  assert.equal(response!.generation, 1);
  assert.equal(response!.requestId, 2);
  const copper = filledCopperPolygons(result.board).get(basis.zones[0].id)!;
  assert.ok(contains(copper, { x: 15, y: 10 }), 'The old route gap is filled again.');
  assert.ok(!contains(copper, { x: 15, y: 13 }), 'Only the current route keeps a clearance gap.');
  assert.ok(!contains(copper, { x: 15, y: 13.44 }));
  assert.ok(contains(copper, { x: 15, y: 13.5 }));
  assert.equal(result.board.zones[0].clearance, 0.25);
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0][0], basis.zones[0].id);
  assert.match(result.paths[0][1], /^M /);
  const native = parseSExpr(exportKiCad({ ...createProject(), pcb: result.board }, 'pcb'));
  const zone = children(native, 'zone')[0];
  assert.equal(Number(val(child(child(zone, 'connect_pads')!, 'clearance'))), 0.25);
  assert.ok(children(zone, 'filled_polygon').length > 0);
  assert.deepEqual(basis, before);
});

test('worker pours and immediate masks use the same native net-class clearance as commit', async () => {
  const { preparePCBFillPreview } = await import('../components/pcbFillPreview');
  const basis = fixture();
  const rules = {
    projectSource: JSON.stringify({
      net_settings: {
        classes: [{ name: 'Default', clearance: 0.7 }],
        netclass_patterns: [],
      },
    }),
  };
  const moved = movePCBSelection(basis, { kind: 'track', id: basis.tracks[0].id }, { x: 0, y: 3 });
  const process = createPCBFillWorkerProcessor();
  process({ type: 'basis', generation: 1, board: basis, rules });
  const result = filled(
    process({ type: 'fill', generation: 1, requestId: 1, board: invalidatePCBFill(basis, moved) }),
  );
  const copper = filledCopperPolygons(result.board).get(basis.zones[0].id)!;
  assert.equal(contains(copper, { x: 15, y: 13.85 }), false);
  assert.equal(contains(copper, { x: 15, y: 13.95 }), true);
  const mask = preparePCBFillPreview(basis, moved, rules);
  assert.ok(mask.zones[0].blockers.some((blocker) => Math.abs(blocker.strokeWidth - 1.8) < 1e-9));
  assert.deepEqual(result.board, fillCopperZones(moved, 0.0001, rules));
});

test('worker restores exact accepted contours for a stripped no-op and owns the posted basis', () => {
  const board = fixture();
  const before = structuredClone(board);
  const process = createPCBFillWorkerProcessor();
  process({ type: 'basis', generation: 1, board });
  board.tracks[0].start.x = 100;
  board.zones[0].filledPolygons = [];
  const stripped = {
    ...before,
    zones: before.zones.map(({ filledPolygons: _filled, ...zone }) => zone),
  };
  const result = filled(process({ type: 'fill', generation: 1, requestId: 1, board: stripped }));
  assert.deepEqual(result.board, before);
  assert.ok(result.paths.length);
  const changed = movePCBSelection(
    before,
    { kind: 'track', id: before.tracks[0].id },
    { x: 0, y: 2 },
  );
  const moved = filled(
    process({
      type: 'fill',
      generation: 1,
      requestId: 2,
      board: invalidatePCBFill(before, changed),
    }),
  );
  assert.notDeepEqual(moved.board.zones[0].filledPolygons, before.zones[0].filledPolygons);
  const noOpAgain = filled(process({ type: 'fill', generation: 1, requestId: 3, board: stripped }));
  assert.deepEqual(noOpAgain.board, before, 'A preview never replaces the single accepted basis.');
});

test('worker rejects stale generations before observing candidates and retains only its newest basis', () => {
  const first = fixture();
  const second = fixture();
  const process = createPCBFillWorkerProcessor();
  process({ type: 'basis', generation: 1, board: first });
  process({ type: 'basis', generation: 2, board: second });
  const stale = {
    type: 'fill',
    generation: 1,
    requestId: 4,
    get board(): PCB {
      throw new Error('A stale candidate must not be observed.');
    },
  } satisfies PCBFillWorkerRequest;
  const response = process(stale);
  assert.match(response!.error!, /inactive board generation/);
  assert.equal(Object.hasOwn(response!, 'board'), false);
  assert.equal(Object.hasOwn(response!, 'paths'), false);
  process({ type: 'basis', generation: 1, board: first });
  const result = filled(process({ type: 'fill', generation: 2, requestId: 5, board: second }));
  assert.equal(result.board.id, second.id);
  const otherBoard = process({ type: 'fill', generation: 2, requestId: 6, board: first });
  assert.match(otherBoard!.error!, /no longer matches its basis/);
});

test('worker fill errors publish no candidate and remain retryable against the retained basis', () => {
  const basis = fixture();
  const process = createPCBFillWorkerProcessor();
  process({ type: 'basis', generation: 1, board: basis });
  const invalid = {
    ...basis,
    zones: basis.zones.map((zone) => ({ ...zone, netId: null })),
  };
  const failed = process({ type: 'fill', generation: 1, requestId: 1, board: invalid });
  assert.match(failed!.error!, /Assign a net/);
  assert.equal(Object.hasOwn(failed!, 'board'), false);
  assert.equal(Object.hasOwn(failed!, 'paths'), false);
  const retried = filled(process({ type: 'fill', generation: 1, requestId: 2, board: basis }));
  assert.deepEqual(retried.board, basis);
});
