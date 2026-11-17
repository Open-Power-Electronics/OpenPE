import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThermalModel, ThermalResult } from '../plugins/layout-thermal/domain/thermal';
import { thermalPadReadouts } from '../plugins/layout-thermal/domain/thermal-pad-view';
import {
  closestThermalNode,
  hottestThermalNode,
  pointOnThermalSurface,
  rasterizeThermalSurface,
  thermalColor,
  thermalSurface,
} from '../plugins/layout-thermal/domain/thermal-view';
import {
  agentThermalContext,
  validateAgentThermalContext,
  type AgentThermalState,
} from '../context/agent-thermal-context';

const result: ThermalResult = {
  version: 1,
  status: 'completed',
  basis: 'thermal-v1:fixture',
  solver: { gmsh: 'fixture', elmer: 'fixture' },
  points: [
    { x: 0, y: 0, z: 1, temperatureC: 30 },
    { x: 10, y: 0, z: 1, temperatureC: 60 },
    { x: 0, y: 10, z: 1, temperatureC: 40 },
    { x: 0, y: 0, z: -1, temperatureC: 28 },
    { x: 10, y: 0, z: -1, temperatureC: 50 },
    { x: 0, y: 10, z: -1, temperatureC: 35 },
  ],
  triangles: [
    [0, 1, 2],
    [3, 4, 5],
    [0, 1, 4],
  ],
  statistics: {
    minC: 28,
    maxC: 60,
    meanC: 40.5,
    inputPowerW: 1,
    outputPowerW: 1,
    energyImbalanceRelative: 0,
    nodeCount: 6,
    elementCount: 3,
  },
  assumptions: ['Explicit power into PCB pads.'],
  diagnostics: [],
};

test('thermal surfaces select actual coplanar boundary triangles and probes return an exact native node', () => {
  assert.deepEqual(thermalSurface(result, 'front').triangles, [[0, 1, 2]]);
  assert.deepEqual(thermalSurface(result, 'back').triangles, [[3, 4, 5]]);
  assert.deepEqual(closestThermalNode(result, { x: 9.5, y: 0.1 }, 'front'), {
    ...result.points[1],
    node: 1,
  });
  assert.deepEqual(closestThermalNode(result, { x: 0, y: 0, z: -0.9 }, 'front'), {
    ...result.points[3],
    node: 3,
  });
  assert.equal(thermalColor(25, 25, 25), thermalColor(0.5, 0, 1));
  assert.equal(thermalColor(1000, 0, 100), thermalColor(100, 0, 100));
});

test('surface maximum ignores hidden and internal nodes, and empty surfaces have no marker', () => {
  assert.equal(hottestThermalNode(result, 'front')?.node, 1);
  assert.equal(hottestThermalNode(result, 'back')?.node, 4);
  const internalHotspot = {
    ...result,
    points: [...result.points, { x: 5, y: 5, z: 0, temperatureC: 100 }],
  };
  assert.equal(hottestThermalNode(internalHotspot, 'front')?.temperatureC, 60);
  assert.equal(hottestThermalNode(internalHotspot, 'back')?.temperatureC, 50);
  assert.equal(hottestThermalNode({ ...result, triangles: [] }, 'front'), null);
});

test('bounded thermal raster retains triangle colours, transparent voids and surface separation', () => {
  const front = rasterizeThermalSurface(result, 'front', 20)!;
  assert.deepEqual(front.bounds, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  assert.equal(front.width, 20);
  assert.equal(front.height, 20);
  const pixel = (image: typeof front, x: number, y: number) => [
    ...image.pixels.slice((y * image.width + x) * 4, (y * image.width + x + 1) * 4),
  ];
  const expected = thermalColor((30 + 60 + 40) / 3, 28, 60)
    .match(/\d+/g)!
    .map(Number);
  assert.deepEqual(pixel(front, 1, 1), [...expected, 255]);
  assert.deepEqual(pixel(front, 19, 19), [0, 0, 0, 0]);
  const back = rasterizeThermalSurface(result, 'back', 20)!;
  assert.notDeepEqual(pixel(front, 1, 1), pixel(back, 1, 1));
  assert.equal(rasterizeThermalSurface({ ...result, triangles: [] }, 'front'), null);
  assert.equal(rasterizeThermalSurface(result, 'front', 2000)!.width, 1600);
});

test('thermal raster and pointer containment retain cutouts and complete shared triangle edges', () => {
  // Four rectangular strips form a board with a square hole; no triangle crosses the hole.
  const coordinates = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
    [1, 1],
    [3, 1],
    [3, 3],
    [1, 3],
  ];
  const ring: ThermalResult = {
    ...result,
    points: coordinates.map(([x, y]) => ({ x, y, z: 1, temperatureC: 40 })),
    triangles: [
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ],
  };
  const raster = rasterizeThermalSurface(ring, 'front', 40)!;
  for (let row = 0; row < 40; row++) {
    for (let column = 0; column < 40; column++) {
      const inHole = row >= 10 && row < 30 && column >= 10 && column < 30;
      assert.equal(raster.pixels[(row * 40 + column) * 4 + 3], inHole ? 0 : 255);
    }
  }
  assert.equal(pointOnThermalSurface(ring, { x: 2, y: 2 }, 'front'), false);
  assert.equal(pointOnThermalSurface(ring, { x: 5, y: 2 }, 'front'), false);
  assert.equal(pointOnThermalSurface(ring, { x: 0.5, y: 2 }, 'front'), true);
  assert.equal(pointOnThermalSurface(ring, { x: 1, y: 2 }, 'front'), true);
  assert.equal(pointOnThermalSurface(ring, { x: 0, y: 0 }, 'front'), true);
});

test('Agent thermal context preserves exact extrema and drops the volume mesh', () => {
  const state: AgentThermalState = {
    boardId: 'board',
    visible: true,
    sourcePending: false,
    status: 'completed',
    settings: null,
    resultSettings: {
      ambientC: 25,
      convection: { top: 10, bottom: 10, edge: 5 },
      copperThicknessMm: [0.035, 0.035],
      dielectricConductivity: 0.3,
      copperConductivity: 400,
      viaPlatingMm: 0.025,
      meshSizeMm: 2,
      heatSources: [{ footprintId: 'part', powerW: 1 }],
    },
    surface: 'front',
    probe: closestThermalNode(result, { x: 0, y: 0 }, 'front'),
    error: '',
    solver: { available: true },
    result,
  };
  const context = agentThermalContext(state);
  validateAgentThermalContext(context, 'board', false);
  validateAgentThermalContext({ ...context, status: 'detecting' }, 'board', false);
  validateAgentThermalContext(
    { ...context, status: 'unavailable', solver: { available: false } },
    'board',
    false,
  );
  assert.equal(context.result?.hottest.temperatureC, 60);
  assert.equal(context.result?.coolest.temperatureC, 28);
  assert.equal('points' in context.result!, false);
  assert.equal('triangles' in context.result!, false);
  const largeMesh = {
    ...context,
    probe: { ...context.probe!, node: 199999 },
    result: {
      ...context.result!,
      statistics: { ...context.result!.statistics, nodeCount: 200000 },
      hottest: { ...context.result!.hottest, node: 199998 },
      coolest: { ...context.result!.coolest, node: 199997 },
    },
  };
  validateAgentThermalContext(largeMesh, 'board', false);
  assert.throws(
    () =>
      validateAgentThermalContext({ ...largeMesh, probe: { ...largeMesh.probe, node: 200000 } }),
    /Invalid Agent thermal/,
  );
  validateAgentThermalContext({ status: 'not-opened' });
  validateAgentThermalContext({ status: 'disabled' });
  for (const value of [
    { ...context, boardId: 'other' },
    { ...context, sourcePending: true },
    { ...context, result: { ...context.result, points: result.points } },
    { status: 'disabled', result: {} },
    { ...context, probe: { ...context.probe, temperatureC: Infinity } },
  ])
    assert.throws(
      () => validateAgentThermalContext(value, 'board', false),
      /Invalid Agent thermal/,
    );
});

test('pad readouts integrate unequal triangle areas, keep board sides separate and reject stale fields', () => {
  const polygon = {
    outer: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 1 },
    ],
    holes: [],
  };
  const model: ThermalModel = {
    version: 1,
    units: 'mm',
    boardId: 'fixture',
    basis: result.basis,
    config: {
      ambientC: 25,
      convection: { top: 10, bottom: 10, edge: 5 },
      copperThicknessMm: [0.035, 0.035],
      dielectricConductivity: 0.3,
      copperConductivity: 400,
      viaPlatingMm: 0.025,
      meshSizeMm: 2,
      heatSources: [],
    },
    board: [polygon],
    layers: [
      { layer: 'F.Cu', zMin: 0.965, zMax: 1, polygons: [polygon] },
      { layer: 'B.Cu', zMin: -1, zMax: -0.965, polygons: [polygon] },
    ],
    dielectricLayers: [],
    barrels: [],
    notices: [],
    assumptions: [],
    sources: [
      {
        footprintId: 'front',
        reference: 'R10',
        powerW: 0.5,
        side: 'front',
        areaMm2: 2,
        polygons: [polygon],
      },
      {
        footprintId: 'back',
        reference: 'Q1',
        powerW: 1,
        side: 'back',
        areaMm2: 2,
        polygons: [polygon],
      },
    ],
  };
  const field: ThermalResult = {
    ...result,
    points: [
      { x: 0, y: 0, z: 1, temperatureC: 0 },
      { x: 4, y: 0, z: 1, temperatureC: 120 },
      { x: 0, y: 1, z: 1, temperatureC: 0 },
      { x: 1, y: 0, z: 1, temperatureC: 0 },
      { x: 0, y: 0, z: -1, temperatureC: 20 },
      { x: 4, y: 0, z: -1, temperatureC: 20 },
      { x: 0, y: 1, z: -1, temperatureC: 20 },
    ],
    triangles: [
      [0, 3, 2],
      [3, 1, 2],
      [4, 5, 6],
    ],
  };
  const before = JSON.stringify([model, field]);
  const rows = thermalPadReadouts(model, field);
  assert.deepEqual(
    rows.map((row) => row.reference),
    ['Q1', 'R10'],
  );
  assert.equal(rows[0].padMeanC, 20);
  assert.equal(rows[0].padMaxC, 20);
  assert.equal(rows[1].padMeanC, 30); // 0.5 mm² at 0 °C + 1.5 mm² at 40 °C.
  assert.equal(rows[1].padMaxC, 120);
  const missing = thermalPadReadouts(model, { ...field, triangles: [[4, 5, 6]] });
  assert.equal(missing[1].padMeanC, null);
  assert.equal(missing[1].padMaxC, null);
  const hole = {
    ...model,
    sources: [
      {
        ...model.sources[0],
        areaMm2: 1.5,
        polygons: [
          {
            ...polygon,
            holes: [
              [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 0, y: 1 },
              ],
            ],
          },
        ],
      },
    ],
  };
  assert.equal(thermalPadReadouts(hole, field)[0].padMeanC, 40);
  assert.throws(() => thermalPadReadouts(model, { ...field, basis: 'stale' }), /does not match/);
  assert.equal(JSON.stringify([model, field]), before);
});
