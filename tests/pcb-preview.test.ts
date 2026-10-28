import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { BoardZone, PCB, Footprint } from '../lib/pcb';
import { boardPolygons, copperPolygons, padPolygon, type Polygon } from '../lib/pcb-polygons';
import { footprintModels, modelPlacement } from '../lib/pcb-models';
import { parseSExpr, child, children, val } from '../lib/sexpr';
import { parseProject, serializeProject, exportKiCad } from '../lib/project';
import manifest from '../resources/example-catalog/manifest.json';
import {
  defaultPCBDisplay,
  pcbFootprintBodyBounds,
  pcbPadLabels,
  pcbReadableTextAngle,
} from '../lib/pcb-display';

const polygon = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const zone = (id = 'pour', netId = 'ground'): BoardZone => ({
  id,
  netId,
  layer: 'F.Cu',
  outline: polygon(-2, -2, 24, 14),
  clearance: 0.25,
  minThickness: 0.1,
  thermalGap: 0.3,
  thermalBridge: 0.3,
  padConnection: 'yes',
});
function board(): PCB {
  const result = createEmptyPCB(),
    points = polygon(0, 0, 20, 10);
  result.graphics = points.map((start, i) => ({
    id: `edge-${i}`,
    start,
    end: points[(i + 1) % points.length],
    width: 0.1,
    layer: 'Edge.Cuts',
  }));
  result.zones = [zone()];
  return result;
}
function insideRing(points: { x: number; y: number }[], x: number, y: number) {
  let contained = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x)
      contained = !contained;
  }
  return contained;
}
const contains = (polygons: Polygon[], x: number, y: number) =>
  polygons.some((p) => insideRing(p.outer, x, y) && !p.holes.some((h) => insideRing(h, x, y)));
const footprint = (netId: string | null): Footprint => ({
  id: 'fp',
  libraryId: 'Test:Pad',
  symbolId: null,
  reference: 'X1',
  value: '',
  x: 5,
  y: 5,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id: 'pad',
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      size: { x: 2, y: 2 },
      shape: 'rect',
      type: 'smd',
      netId,
    },
  ],
});

test('pad annotations fit long nets, follow pad axes and stay readable without changing design data', () => {
  const pad = footprint('ground').pads[0];
  const before = structuredClone(pad);
  const visible = defaultPCBDisplay();
  for (const rotation of [-450, -180, -90, 0, 45, 90, 180, 270, 540]) {
    for (const size of [
      { x: 3, y: 1 },
      { x: 1, y: 3 },
      { x: 1, y: 1 },
    ]) {
      const sample = { ...pad, size };
      const labels = pcbPadLabels(sample, rotation, '/Power/Net-(U1-FB)', visible);
      assert.deepEqual(
        labels.lines.map((l) => l.text),
        ['1', 'Net-(U1-FB)'],
      );
      const angle = ((((-rotation + labels.rotation + 540) % 360) + 360) % 360) - 180;
      assert.ok(Math.abs(angle) <= 90, `Readable text at ${rotation} degrees.`);
      for (const line of labels.lines) {
        assert.ok(line.size > 0 && Number.isFinite(line.size));
        assert.ok(line.size * line.text.length * 0.62 <= Math.max(size.x, size.y) * 0.82);
        assert.ok(Math.abs(line.y) + line.size / 2 < Math.min(size.x, size.y) / 2);
      }
    }
  }
  assert.deepEqual(pad, before);
  assert.equal(
    pcbPadLabels(pad, 90, 'GND', visible).rotation,
    90,
    'Square pads read horizontally.',
  );
  assert.equal(pcbReadableTextAngle(180), 0);
  assert.equal(pcbReadableTextAngle(270), 90);
  visible.padNumbers = false;
  assert.deepEqual(
    pcbPadLabels(pad, 0, '/GND', visible).lines.map((l) => l.text),
    ['GND'],
  );
  visible.padNets = false;
  assert.equal(pcbPadLabels(pad, 0, '/GND', visible).lines.length, 0);
  visible.padNumbers = true;
  const single = pcbPadLabels(pad, 0, undefined, visible).lines;
  assert.equal(single[0].y, 0);
  assert.equal(
    pcbPadLabels({ ...pad, type: 'np_thru_hole' }, 0, 'GND', defaultPCBDisplay()).lines.length,
    0,
  );
});

test('footprint selection bounds use visible local geometry without captions or empty origin space', () => {
  const pcb = createEmptyPCB(),
    visible = defaultPCBDisplay();
  const f = footprint(null);
  f.rotation = 45;
  f.pads[0] = { ...f.pads[0], x: 10, size: { x: 4, y: 2 }, rotation: 90 };
  f.graphics = [
    {
      id: 'reference',
      kind: 'text',
      layer: 'F.SilkS',
      width: 0.15,
      start: { x: -20, y: -20 },
      end: { x: -20, y: -20 },
      text: { value: '${REFERENCE}', size: { x: 1, y: 1 }, rotation: 0, thickness: 0.15 },
    },
  ];
  const original = structuredClone(f);
  assert.deepEqual(pcbFootprintBodyBounds(pcb, f, visible), {
    minX: 9,
    minY: -2,
    maxX: 11,
    maxY: 2,
  });
  assert.deepEqual(f, original, 'Selection bounds do not change footprint geometry.');
  f.pads[0].layers = ['B.Cu'];
  visible['B.Cu'] = false;
  assert.equal(
    pcbFootprintBodyBounds(pcb, f, visible),
    null,
    'Text alone has no body hit rectangle.',
  );
  f.graphics.push({
    id: 'body',
    layer: 'F.SilkS',
    width: 0.2,
    start: { x: 8, y: -1 },
    end: { x: 12, y: 1 },
  });
  assert.deepEqual(pcbFootprintBodyBounds(pcb, f, visible), {
    minX: 7.9,
    minY: -1.1,
    maxX: 12.1,
    maxY: 1.1,
  });
  visible['F.SilkS'] = false;
  assert.equal(pcbFootprintBodyBounds(pcb, f, visible), null);
  visible['B.Cu'] = true;
  visible.footprints = false;
  assert.equal(pcbFootprintBodyBounds(pcb, f, visible), null);
});

test('copper is clipped to closed board edges and cutouts; open outlines fail visibly', () => {
  const pcb = board();
  pcb.graphics.push({
    id: 'hole',
    layer: 'Edge.Cuts',
    kind: 'circle',
    start: { x: 10, y: 5 },
    end: { x: 11, y: 5 },
    width: 0.1,
  });
  const fill = copperPolygons(pcb).get('pour')!;
  assert.ok(contains(fill, 2, 2));
  assert.ok(!contains(fill, -1, 2) && !contains(fill, 10, 5) && !contains(fill, 11.1, 5));
  assert.ok(!contains(fill, 0.1, 5));
  pcb.graphics.splice(0, 1);
  assert.throws(() => boardPolygons(pcb), /open or ambiguous/);
});
test('copper separates foreign pads/tracks/vias, zone holes and footprint keepouts without mutating data', () => {
  const pcb = board();
  pcb.footprints = [footprint('signal')];
  pcb.tracks = [
    {
      id: 'track',
      netId: 'signal',
      layer: 'F.Cu',
      start: { x: 10, y: 2 },
      end: { x: 10, y: 8 },
      width: 0.4,
    },
  ];
  pcb.vias = [{ id: 'via', netId: 'signal', x: 15, y: 5, diameter: 1, drill: 0.5 }];
  pcb.zones[0].holes = [polygon(1, 1, 1, 1)];
  pcb.footprints[0].zones = [
    {
      ...zone('keepout'),
      netId: null,
      outline: polygon(2, 1, 1, 1),
      keepout: { copperpour: true, tracks: false, vias: false, pads: false, footprints: false },
    },
  ];
  const before = JSON.stringify(pcb),
    fill = copperPolygons(pcb).get('pour')!;
  for (const [x, y] of [
    [5, 5],
    [6.1, 5],
    [10, 5],
    [10.3, 5],
    [15, 5],
    [1.5, 1.5],
    [7.5, 6.5],
  ])
    assert.ok(!contains(fill, x, y), `${x},${y} is cleared`);
  assert.ok(contains(fill, 3, 3));
  assert.equal(JSON.stringify(pcb), before);
});
test('same-net solid pads remain connected; thermal settings cut gaps and retain bridges', () => {
  const pcb = board();
  pcb.footprints = [footprint('ground')];
  assert.ok(contains(copperPolygons(pcb).get('pour')!, 6.15, 5));
  delete pcb.zones[0].padConnection;
  const fill = copperPolygons(pcb).get('pour')!;
  assert.ok(contains(fill, 6.15, 5));
  assert.ok(!contains(fill, 6.15, 5.7));
  pcb.zones[0].fillEnabled = false;
  assert.equal(copperPolygons(pcb).size, 0);
});
test('priority resolves different-net overlaps, and geometry limits fail without partial fills', () => {
  const pcb = board();
  pcb.zones.push({ ...zone('power', 'power'), outline: polygon(8, 2, 5, 6), priority: 10 });
  const fills = copperPolygons(pcb);
  assert.ok(!contains(fills.get('pour')!, 10, 5));
  assert.ok(contains(fills.get('power')!, 10, 5));
  pcb.zones = Array.from({ length: 65 }, (_, i) => zone(String(i)));
  assert.throws(() => copperPolygons(pcb), /geometry limit/);
});
test('3D model transforms survive canonical/native round trips and use board millimetres on both sides', () => {
  const project = parseProject(
    readFileSync(`tests/fixtures/reference/${manifest.examples[0].file}.json`, 'utf8'),
  );
  const f = project.pcb!.footprints[0];
  assert.ok(f.models?.length);
  f.models[0].opacity = 0.3;
  assert.deepEqual(parseProject(serializeProject(project)).pcb!.footprints[0].models, f.models);
  const native = parseSExpr(exportKiCad(project, 'pcb'));
  const exported = children(native, 'footprint').find((n) => val(child(n, 'uuid')) === f.id)!;
  assert.deepEqual(footprintModels(exported), f.models);
  assert.deepEqual(modelPlacement({ x: 10, y: 20, rotation: 90, side: 'back' }, 1.6), {
    x: 10,
    y: -20,
    z: -0.8,
    rotation: Math.PI / 2,
    flipped: true,
  });
  const invalid = structuredClone(project);
  invalid.pcb!.footprints[0].models![0].scale.x = 0;
  assert.throws(() => serializeProject(invalid));
  for (const opacity of [-0.1, 1.1, NaN, Infinity]) {
    const invalidOpacity = structuredClone(project);
    invalidOpacity.pcb!.footprints[0].models![0].opacity = opacity;
    assert.throws(() => serializeProject(invalidOpacity));
  }
  for (const opacity of ['-0.1', '1.1', 'NaN', 'Infinity', '', '0.3 extra', '(xyz 0.3 0 0)'])
    assert.throws(
      () => footprintModels(parseSExpr(`(footprint "X" (model "X" (opacity ${opacity})))`)),
      /opacity/,
    );
  assert.throws(
    () => footprintModels(parseSExpr('(footprint "X" (model "X" (opacity 0.3) (opacity 0.5)))')),
    /Repeated/,
  );
  for (const opacity of [0, 1])
    assert.equal(
      footprintModels(parseSExpr(`(footprint "X" (model "X" (opacity ${opacity})))`))[0].opacity,
      opacity,
    );
  assert.throws(() =>
    footprintModels(parseSExpr('(footprint "X" (model "X" (offset (xyz NaN 0 0))))')),
  );
  assert.throws(
    () => footprintModels(parseSExpr('(footprint "X" (model "X" (scale (xyz 1 0 1))))')),
    /scales/,
  );
  assert.throws(
    () =>
      footprintModels(
        parseSExpr('(footprint "X" (model "X" (offset (xyz 1 0 1)) (offset (xyz 2 0 1))))'),
      ),
    /Repeated/,
  );
  assert.equal(
    footprintModels(parseSExpr('(footprint "X" (model "X" (hide no)))'))[0].hidden,
    undefined,
  );
});
test('rounded and chamfered pads use their actual dimensions and rotation', () => {
  const f = footprint('ground');
  f.rotation = 90;
  f.pads[0].size = { x: 4, y: 2 };
  f.pads[0].shape = 'roundrect';
  f.pads[0].roundrectRatio = 0.25;
  const p = padPolygon(f, f.pads[0]);
  assert.ok(contains([p], 5, 6.9));
  assert.ok(!contains([p], 6.1, 5));
  f.pads[0].chamferRatio = 0.5;
  f.pads[0].chamfer = ['top_left'];
  assert.ok(padPolygon(f, f.pads[0]).outer.length > 3);
});
for (const entry of manifest.examples)
  test(`${entry.id}: finite bounded board/copper previews preserve complete canonical bytes`, () => {
    const project = parseProject(
      readFileSync(`tests/fixtures/reference/${entry.file}.json`, 'utf8'),
    );
    const before = serializeProject(project),
      board = project.pcb!;
    const rings = [...boardPolygons(board), ...[...copperPolygons(board).values()].flat()];
    assert.ok(rings.length);
    assert.ok(
      rings.every((p) =>
        [p.outer, ...p.holes].flat().every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
      ),
    );
    assert.equal(serializeProject(project), before);
  });
