import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCapabilitySchema } from '../api/capability-schema';
import type { BoardZone, Footprint, PCB } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { Polygon } from '../lib/pcb-polygons';
import { thermalPolygonArea } from '../lib/thermal-geometry';
import {
  defaultThermalConfig,
  prepareThermalModel,
  thermalConfigSchema,
  thermalResultSchema,
  validateThermalConfig,
  validateThermalResult,
  type ThermalConfig,
  type ThermalResult,
} from '../lib/thermal';

const rectangle = (x: number, y: number, width: number, height: number) => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];
function footprint(id = 'fp'): Footprint {
  return {
    id,
    libraryId: 'Test:Pad',
    symbolId: null,
    reference: 'U1',
    value: '',
    x: 5,
    y: 5,
    side: 'front',
    rotation: 0,
    graphics: [],
    pads: [
      {
        id: 'pad',
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'rect',
        size: { x: 2, y: 2 },
        netId: 'gnd',
      },
    ],
  };
}
function board(): PCB {
  const board = createEmptyPCB();
  const points = rectangle(0, 0, 20, 10);
  board.graphics = points.map((start, i) => ({
    id: `edge-${i}`,
    layer: 'Edge.Cuts',
    width: 0.1,
    start,
    end: points[(i + 1) % points.length],
  }));
  board.nets = [{ id: 'gnd', name: 'GND' }];
  board.footprints = [footprint()];
  return board;
}
function scenario(board: PCB): ThermalConfig {
  return { ...defaultThermalConfig(board), heatSources: [{ footprintId: 'fp', powerW: 1 }] };
}
function zone(): BoardZone {
  return {
    id: 'pour',
    netId: 'gnd',
    layer: 'F.Cu',
    outline: rectangle(0, 0, 20, 10),
    clearance: 0.25,
    minThickness: 0.1,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  };
}
function insideRing(points: { x: number; y: number }[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const contains = (polygons: Polygon[], x: number, y: number) =>
  polygons.some((p) => insideRing(p.outer, x, y) && !p.holes.some((h) => insideRing(h, x, y)));

test('thermal configuration schemas use the interpreted subset and reject unsupported physical inputs', () => {
  const pcb = board();
  const config = scenario(pcb);
  assert.equal(compileCapabilitySchema(thermalConfigSchema)(config).valid, true);
  assert.deepEqual(validateThermalConfig(config, pcb), config);
  for (const invalid of [
    { ...config, ambientC: -273.15 },
    { ...config, ambientC: NaN },
    { ...config, dielectricConductivity: 0 },
    { ...config, copperConductivity: Infinity },
    { ...config, viaPlatingMm: -0.1 },
    { ...config, meshSizeMm: 0 },
    { ...config, convection: { top: -1, bottom: 10, edge: 5 } },
    { ...config, copperThicknessMm: [0.035, 0.035, 0.035] },
    { ...config, copperThicknessMm: [1, 1] },
    { ...config, heatSources: [{ footprintId: 'fp', powerW: -1 }] },
    { ...config, heatSources: [{ footprintId: 'missing', powerW: 1 }] },
    {
      ...config,
      heatSources: [
        { footprintId: 'fp', powerW: 1 },
        { footprintId: 'fp', powerW: 2 },
      ],
    },
    { ...config, executable: 'elmer' },
  ])
    assert.throws(() => validateThermalConfig(invalid, pcb), /thermal|copper|footprint/i);
});

test('thermal settings and geometry are detached analysis data and preserve the native board', () => {
  const pcb = board();
  pcb.vias = [{ id: 'via', x: 10, y: 5, diameter: 0.6, drill: 0.3, netId: 'gnd' }];
  pcb.graphics.push({
    id: 'cutout',
    kind: 'circle',
    layer: 'Edge.Cuts',
    start: { x: 15, y: 5 },
    end: { x: 16, y: 5 },
    width: 0.1,
  });
  const config = scenario(pcb);
  const before = structuredClone({ pcb, config });
  const model = prepareThermalModel(pcb, config);
  assert.deepEqual({ pcb, config }, before);
  assert.equal(model.units, 'mm');
  assert.equal(model.sources[0].footprintId, 'fp');
  assert.equal(model.sources[0].powerW, 1);
  assert.equal(model.sources[0].areaMm2, 4);
  assert.equal(model.barrels.length, 1);
  assert.deepEqual(Object.keys(model.barrels[0]).sort(), [
    'id',
    'innerRadiusMm',
    'outerRadiusMm',
    'polygons',
    'x',
    'y',
    'zMax',
    'zMin',
  ]);
  assert.equal(model.barrels[0].innerRadiusMm, 0.15);
  assert.equal(model.barrels[0].outerRadiusMm, 0.175);
  assert.equal(
    contains(model.barrels[0].polygons, 10, 5),
    false,
    'the copper barrel remains hollow',
  );
  assert.equal(contains(model.barrels[0].polygons, 10.16, 5), true);
  assert.ok(
    Math.abs(thermalPolygonArea(model.barrels[0].polygons) - Math.PI * (0.175 ** 2 - 0.15 ** 2)) <
      0.001,
  );
  assert.equal(contains(model.board, 15, 5), false, 'mechanical cutout remains a hole');
  assert.equal(contains(model.board, 10, 5), false, 'drilled via remains a hole');
  assert.equal(model.layers[0].zMax, pcb.thickness / 2);
  assert.ok(Math.abs(model.layers[1].zMin + pcb.thickness / 2) < 1e-12);
  assert.equal(model.dielectricLayers.length, 1);
  assert.ok(model.assumptions.some((assumption) => assumption.includes('junction')));
  model.config.heatSources[0].powerW = 9;
  model.sources[0].polygons[0].outer[0].x = -10;
  assert.deepEqual({ pcb, config }, before);
});

test('unfilled zone outlines never become thermal copper and saved fill holes remain empty', () => {
  const pcb = board();
  const pour = zone();
  pcb.zones = [pour];
  const before = structuredClone(pcb);
  assert.throws(() => prepareThermalModel(pcb, scenario(pcb)), /Fill copper zones in Layout/);
  assert.deepEqual(pcb, before);
  pour.fillEnabled = false;
  let model = prepareThermalModel(pcb, scenario(pcb));
  assert.equal(contains(model.layers[0].polygons, 15, 5), false);
  const unfilledArea = thermalPolygonArea(model.layers[0].polygons);
  pour.fillEnabled = true;
  pour.filledPolygons = [];
  model = prepareThermalModel(pcb, scenario(pcb));
  assert.equal(thermalPolygonArea(model.layers[0].polygons), unfilledArea);
  assert.equal(model.notices.length, 0);
  // A doubled bridge is the native-style contour for a hole in the filled copper.
  pour.filledPolygons = [
    {
      points: [
        { x: 10, y: 1 },
        { x: 19, y: 1 },
        { x: 19, y: 9 },
        { x: 10, y: 9 },
        { x: 10, y: 1 },
        { x: 13, y: 3 },
        { x: 13, y: 7 },
        { x: 17, y: 7 },
        { x: 17, y: 3 },
        { x: 13, y: 3 },
        { x: 10, y: 1 },
      ],
    },
  ];
  model = prepareThermalModel(pcb, scenario(pcb));
  assert.equal(contains(model.layers[0].polygons, 11, 5), true);
  assert.equal(contains(model.layers[0].polygons, 15, 5), false);
  assert.equal(contains(model.layers[0].polygons, 8, 5), false, 'zone outline is never a fallback');
  pcb.tracks.push({
    id: 'track',
    start: { x: 6, y: 2 },
    end: { x: 8, y: 2 },
    width: 0.3,
    layer: 'F.Cu',
    netId: 'gnd',
  });
  // Layout invalidates saved fills after a copper edit. Analysis must require an explicit refill.
  delete pour.filledPolygons;
  assert.throws(() => prepareThermalModel(pcb, scenario(pcb)), /invalidated zone outlines/);
});

test('four-layer adaptation retains layer order, physical pad sides and through-hole paths', () => {
  const pcb = board();
  pcb.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  pcb.footprints[0].side = 'back';
  pcb.footprints[0].rotation = 90;
  pcb.footprints[0].pads[0].x = 1;
  pcb.tracks = [
    {
      id: 'track',
      start: { x: 3, y: 2 },
      end: { x: 12, y: 2 },
      width: 0.4,
      layer: 'In1.Cu',
      netId: 'gnd',
    },
  ];
  const thru = footprint('thru');
  thru.x = 10;
  thru.pads[0] = {
    ...thru.pads[0],
    id: 'thru-pad',
    type: 'thru_hole',
    shape: 'circle',
    drill: 0.8,
  };
  const mechanical = footprint('mechanical');
  mechanical.x = 15;
  mechanical.pads[0] = {
    ...mechanical.pads[0],
    id: 'np-pad',
    type: 'np_thru_hole',
    shape: 'circle',
    drill: 1,
  };
  pcb.footprints.push(thru, mechanical);
  const model = prepareThermalModel(pcb, scenario(pcb));
  assert.deepEqual(
    model.layers.map((layer) => layer.layer),
    pcb.layers,
  );
  assert.equal(model.dielectricLayers.length, 3);
  assert.equal(model.sources[0].side, 'back');
  assert.equal(contains(model.layers[1].polygons, 7, 2), true);
  assert.equal(contains(model.layers[0].polygons, 7, 2), false);
  assert.equal(contains(model.layers[0].polygons, 5, 6), false);
  assert.ok(
    thermalPolygonArea(model.layers[3].polygons) > thermalPolygonArea(model.layers[2].polygons),
  );
  assert.equal(model.barrels.length, 1, 'NPTH has no conductive barrel');
  assert.equal(contains(model.board, 10, 5), false);
  assert.equal(contains(model.board, 15, 5), false);
  assert.throws(
    () => validateThermalConfig({ ...scenario(pcb), copperThicknessMm: [0.035, 0.035] }, pcb),
    /each PCB copper layer/,
  );
});

test('thermal basis changes for actual copper, placement, power and materials while ignoring display-only geometry', () => {
  const pcb = board();
  const config = scenario(pcb);
  const basis = prepareThermalModel(pcb, config).basis;
  pcb.graphics.push({
    id: 'silk',
    layer: 'F.SilkS',
    width: 0.1,
    start: { x: 0, y: 0 },
    end: { x: 10, y: 2 },
  });
  pcb.footprints[0].models = [
    {
      path: 'visual.step',
      offset: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  ];
  assert.equal(prepareThermalModel(pcb, config).basis, basis);
  assert.notEqual(prepareThermalModel(pcb, { ...config, copperConductivity: 390 }).basis, basis);
  assert.notEqual(
    prepareThermalModel(pcb, { ...config, heatSources: [{ footprintId: 'fp', powerW: 2 }] }).basis,
    basis,
  );
  pcb.footprints[0].x += 1;
  assert.notEqual(prepareThermalModel(pcb, config).basis, basis);
  pcb.footprints[0].x -= 1;
  pcb.tracks.push({
    id: 'new',
    start: { x: 10, y: 5 },
    end: { x: 12, y: 5 },
    width: 0.4,
    layer: 'F.Cu',
    netId: 'gnd',
  });
  assert.notEqual(prepareThermalModel(pcb, config).basis, basis);
});

test('unsupported or stale thermal scenarios fail before any mutation', () => {
  const pcb = board();
  const config = scenario(pcb);
  assert.throws(() => prepareThermalModel(pcb, defaultThermalConfig(pcb)), /positive heat/);
  assert.throws(
    () => prepareThermalModel(pcb, { ...config, convection: { top: 0, bottom: 0, edge: 0 } }),
    /positive convection/,
  );
  const unsupported = structuredClone(pcb);
  unsupported.graphics.pop();
  assert.throws(() => prepareThermalModel(unsupported, config), /open or ambiguous/);
  const noPads = structuredClone(pcb);
  noPads.footprints[0].pads = [];
  assert.throws(() => prepareThermalModel(noPads, config), /no copper pad area/);
  const bad = structuredClone(pcb);
  bad.vias.push({ id: 'small', x: 10, y: 5, diameter: 0.32, drill: 0.3, netId: 'gnd' });
  assert.throws(() => prepareThermalModel(bad, config), /plating exceeds/);
  const copperText = structuredClone(pcb);
  copperText.graphics.push({
    id: 'copper-text',
    layer: 'F.Cu',
    width: 0.1,
    kind: 'text',
    start: { x: 1, y: 1 },
    end: { x: 1, y: 1 },
  });
  const before = structuredClone(copperText);
  assert.throws(() => prepareThermalModel(copperText, config), /Copper text/);
  assert.deepEqual(copperText, before);
  const huge = structuredClone(pcb);
  huge.footprints = Array.from({ length: 257 }, (_, index) => footprint(`fp${index}`));
  assert.throws(
    () =>
      prepareThermalModel(huge, { ...config, heatSources: [{ footprintId: 'fp0', powerW: 1 }] }),
    /geometry limit/,
  );
});

function result(): ThermalResult {
  return {
    version: 1,
    status: 'completed',
    basis: 'test-basis',
    solver: { gmsh: '4.15.2', elmer: '26.2' },
    points: [
      { x: 0, y: 0, z: 0.8, temperatureC: 25 },
      { x: 1, y: 0, z: 0.8, temperatureC: 26 },
      { x: 0, y: 1, z: 0.8, temperatureC: 27 },
    ],
    triangles: [[0, 1, 2]],
    statistics: {
      minC: 25,
      maxC: 27,
      meanC: 26,
      inputPowerW: 1,
      outputPowerW: 0.99,
      energyImbalanceRelative: 0.01,
      nodeCount: 3,
      elementCount: 1,
    },
    assumptions: ['Uniform stackup'],
    diagnostics: [],
  };
}

test('thermal result validation rejects fabricated summaries, invalid meshes and incomplete outputs', () => {
  const valid = result();
  assert.equal(compileCapabilitySchema(thermalResultSchema)(valid).valid, true);
  assert.deepEqual(validateThermalResult(valid), valid);
  for (const change of [
    (r: ThermalResult) => {
      r.points[0].temperatureC = NaN;
    },
    (r: ThermalResult) => {
      r.points[0].x = Infinity;
    },
    (r: ThermalResult) => {
      r.triangles = [[0, 1, 3]];
    },
    (r: ThermalResult) => {
      r.triangles = [[0, 0, 2]];
    },
    (r: ThermalResult) => {
      r.points[2] = { ...r.points[1] };
    },
    (r: ThermalResult) => {
      r.statistics.minC = 10;
    },
    (r: ThermalResult) => {
      r.statistics.maxC = 100;
    },
    (r: ThermalResult) => {
      r.statistics.meanC = 40;
    },
    (r: ThermalResult) => {
      r.statistics.nodeCount = 4;
    },
    (r: ThermalResult) => {
      r.statistics.energyImbalanceRelative = 0;
    },
    (r: ThermalResult) => {
      r.points = [];
    },
    (r: ThermalResult) => {
      r.triangles = [];
    },
  ]) {
    const bad = result();
    change(bad);
    assert.throws(() => validateThermalResult(bad), /thermal result/i);
  }
  const detached = validateThermalResult(valid);
  detached.points[0].temperatureC = 500;
  assert.equal(valid.points[0].temperatureC, 25);
  const oversized = result();
  oversized.points = Array.from({ length: 200001 }, () => valid.points[0]);
  assert.throws(() => validateThermalResult(oversized), /item count/);
});
