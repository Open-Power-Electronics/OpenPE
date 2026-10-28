import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BoardLine } from '../lib/pcb';
import { graphicPolygons, intersectPolygons, type Polygon } from '../lib/pcb-polygons';
import { pcbSilkscreen } from '../lib/pcb-silkscreen';
import { createEmptyPCB } from '../lib/pcb-layout';
import { solderMaskOpenings } from '../lib/pcb-solder-mask';
import { parseProject, serializeProject } from '../lib/project';
import { projectNativeFiles } from '../lib/kicad-project';

function bounds(polygons: Polygon[]) {
  const points = polygons.flatMap((polygon) => polygon.outer);
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}
function covers(polygons: Polygon[], x: number, y: number) {
  return (
    intersectPolygons(polygons, [
      {
        outer: [
          { x: x - 0.0002, y: y - 0.0002 },
          { x: x + 0.0002, y: y - 0.0002 },
          { x: x + 0.0002, y: y + 0.0002 },
          { x: x - 0.0002, y: y + 0.0002 },
        ],
        holes: [],
      },
    ]).length > 0
  );
}
const circle = (fill: boolean, width = 0.3): BoardLine => ({
  id: 'circle',
  kind: 'circle',
  layer: 'F.SilkS',
  fill,
  width,
  start: { x: 2, y: 3 },
  end: { x: 2.4, y: 3 },
});

test('filled physical artwork retains native strokes while unfilled loops retain open centres', () => {
  for (const fill of [false, true]) {
    const source = circle(fill),
      before = structuredClone(source),
      polygons = graphicPolygons(source);
    assert.ok(
      covers(polygons, 2.53, 3),
      'The 0.3 mm stroke extends 0.15 mm outside its 0.4 mm radius',
    );
    assert.ok(!covers(polygons, 2.57, 3));
    assert.equal(covers(polygons, 2, 3), fill);
    assert.deepEqual(source, before);
    assert.ok(Math.abs(bounds(polygons).maxX - 2.55) < 0.01);
  }
  const thin: BoardLine = {
    id: 'line',
    layer: 'F.SilkS',
    width: 0.01,
    start: { x: 0, y: 0 },
    end: { x: 4, y: 0 },
  };
  assert.ok(covers(graphicPolygons(thin), 2, 0.004));
  assert.ok(!covers(graphicPolygons(thin), 2, 0.006), 'No display minimum widens physical artwork');
  assert.deepEqual(graphicPolygons({ ...thin, width: 0 }), []);
});

test('polygon closure and open arc caps retain exact native paths without diagonal joins', () => {
  const polygon: BoardLine = {
    id: 'polygon',
    kind: 'polygon',
    layer: 'F.SilkS',
    width: 0.2,
    start: { x: 0, y: 0 },
    points: [
      { x: 4, y: 0 },
      { x: 4, y: 3 },
    ],
    end: { x: 0, y: 3 },
  };
  const outline = graphicPolygons(polygon);
  assert.ok(covers(outline, 0, 1.5), 'The implicit last edge closes the polygon');
  assert.ok(!covers(outline, 2, 1.5));
  const filled = graphicPolygons({ ...polygon, fill: true });
  assert.ok(covers(filled, 2, 1.5));
  assert.ok(covers(filled, -0.08, 1.5));
  const arc: BoardLine = {
    id: 'arc',
    kind: 'arc',
    layer: 'F.SilkS',
    width: 0.2,
    start: { x: -1, y: 0 },
    mid: { x: 0, y: 1 },
    end: { x: 1, y: 0 },
  };
  const curved = graphicPolygons(arc);
  assert.ok(covers(curved, 0, 1));
  assert.ok(!covers(curved, 0, 0), 'An open arc does not acquire a closing diameter');
  assert.ok(covers(curved, 1.07, 0), 'Native open strokes retain round endpoint caps');
  const independent = graphicPolygons({ ...polygon, fill: true, width: 0 });
  independent[0].outer[0].x = 99;
  assert.equal(polygon.start.x, 0);
});

test('mask filled artwork opens the complete fill and stroke after native footprint transforms', () => {
  const board = createEmptyPCB();
  board.footprints = [
    {
      id: 'footprint',
      symbolId: null,
      libraryId: 'Test:Mask',
      x: 10,
      y: 10,
      rotation: 90,
      side: 'front',
      pads: [],
      graphics: [{ ...circle(true), layer: 'F.Mask' }],
    },
  ];
  const before = structuredClone(board),
    front = solderMaskOpenings(board, 'front');
  // Local (2,3) rotated -90 degrees about (10,10) becomes (13,8).
  assert.ok(covers(front.openings, 13, 8));
  assert.ok(covers(front.openings, 13, 7.47), 'The full native stroke opens the mask');
  assert.ok(!covers(front.openings, 13, 7.43));
  assert.deepEqual(solderMaskOpenings(board, 'back').openings, []);
  assert.deepEqual(board, before);
});

test('actual EMC filled silk keeps circle and triangle stroke bounds without changing native Source', () => {
  const project = parseProject(readFileSync('lib/emc-flyback-example.json', 'utf8'));
  const source = serializeProject(project),
    native = projectNativeFiles(project);
  const filled = pcbSilkscreen(project.pcb!, project.schematic).filter((g) => g.fill);
  assert.equal(filled.length, 4);
  const disk = filled.find((g) => g.kind === 'circle')!;
  assert.deepEqual(disk.start, { x: 97, y: 77 });
  assert.ok(covers(graphicPolygons(disk), 97.53, 77));
  assert.ok(!covers(graphicPolygons(disk), 97.57, 77));
  for (const triangle of filled.filter((g) => g.kind === 'polygon')) {
    const original = bounds([
      { outer: [triangle.start, ...(triangle.points ?? []), triangle.end], holes: [] },
    ]);
    const painted = bounds(graphicPolygons(triangle));
    assert.ok(painted.minX < original.minX - 0.04);
    assert.ok(painted.maxX > original.maxX + 0.04);
  }
  assert.equal(serializeProject(project), source);
  assert.deepEqual(projectNativeFiles(project), native);
});
