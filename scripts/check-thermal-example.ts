import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { uid } from '../lib/circuit';
import { parseProject, serializeProject, type Project } from '../lib/project';
import { createEmptyPCB } from '../lib/pcb-layout';
import {
  defaultThermalConfig,
  prepareThermalModel,
  validateThermalResult,
  type ThermalConfig,
  type ThermalResult,
} from '../plugins/layout-thermal/domain/thermal';
import { thermalColor, thermalSurface } from '../plugins/layout-thermal/domain/thermal-view';
import {
  detectThermal,
  runThermalSimulation,
} from '../plugins/layout-thermal/host/thermal-runtime.mjs';
import { startServer } from '../server/index.mjs';

// Explicit, offline real-solver check. This is never invoked by npm test.
const directory = 'test-results/thermal';
await mkdir(directory, { recursive: true });
const control = new AbortController();
process.once('SIGINT', () => control.abort());
const solver = await detectThermal(control.signal);
assert.ok(solver.available, solver.diagnostic || 'Prepare the bundled thermal solvers first.');

async function runThroughService(project: Project, config: ThermalConfig) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'openpe-thermal-check-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ dataDir: temporary });
    const response = await fetch(`${server.base}/api/thermal/run`, {
      method: 'POST',
      headers: { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: serializeProject(project), config }),
      signal: control.signal,
    });
    const body = await response.json();
    assert.equal(response.status, 200, body.error || 'Authenticated thermal execution failed.');
    return validateThermalResult(body.result);
  } finally {
    server?.close();
    if (
      path.dirname(path.resolve(temporary)) !== path.resolve(tmpdir()) ||
      !path.basename(temporary).startsWith('openpe-thermal-check-')
    )
      throw new Error('Invalid thermal verification directory.');
    await rm(temporary, { recursive: true, force: true });
  }
}

const corners = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
const slab = createEmptyPCB();
slab.graphics = corners.map((start, i) => ({
  id: uid(),
  start,
  end: corners[(i + 1) % 4],
  width: 0.1,
  layer: 'Edge.Cuts',
}));
slab.footprints = [
  {
    id: uid(),
    symbolId: null,
    libraryId: 'Thermal:UniformHeater',
    reference: 'H1',
    x: 5,
    y: 5,
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
        shape: 'rect',
        size: { x: 10, y: 10 },
        netId: null,
      },
    ],
  },
];
slab.zones = [
  {
    id: uid(),
    layer: 'B.Cu',
    netId: null,
    outline: corners,
    filledPolygons: [{ points: corners }],
    clearance: 0.2,
    minThickness: 0.1,
    thermalGap: 0.2,
    thermalBridge: 0.2,
    fillEnabled: true,
  },
];
const slabConfig = defaultThermalConfig(slab);
slabConfig.heatSources = [{ footprintId: slab.footprints[0].id, powerW: 0.01 }];
slabConfig.convection.edge = 0;
slabConfig.meshSizeMm = 2;
const slabModel = prepareThermalModel(slab, slabConfig);
console.log('Checking the analytical one-dimensional layered slab with Gmsh and Elmer…');
const slabResult = validateThermalResult(await runThermalSimulation(slabModel, control.signal));
const area = 0.01 * 0.01;
const copperM = slabConfig.copperThicknessMm.reduce((sum, item) => sum + item / 1000, 0);
const resistance =
  copperM / (slabConfig.copperConductivity * area) +
  (slab.thickness / 1000 - copperM) / (slabConfig.dielectricConductivity * area);
const frontConductance = slabConfig.convection.top * area;
const backConductance = slabConfig.convection.bottom * area;
const expectedRise =
  0.01 / (frontConductance + backConductance / (1 + backConductance * resistance));
const front = thermalSurface(slabResult, 'front');
const observedRise =
  front.indices.reduce((sum, i) => sum + slabResult.points[i].temperatureC, 0) /
    front.indices.length -
  slabConfig.ambientC;
const analyticalRelativeError = Math.abs(observedRise - expectedRise) / expectedRise;
assert.ok(
  analyticalRelativeError < 0.005,
  `Layered slab relative error ${analyticalRelativeError} exceeds 0.5%.`,
);
assert.ok(
  slabResult.statistics.energyImbalanceRelative < 0.005,
  'Layered slab energy balance exceeds 0.5%.',
);

const catalogFile = 'lib/reference-examples.json';
const catalogBytes = await readFile(catalogFile);
const catalogHash = createHash('sha256').update(catalogBytes).digest('hex');
const examples = JSON.parse(catalogBytes.toString('utf8'));
const id = 'reference-lm2596-to220-5-buck';
const project = parseProject(examples[id]);
assert.ok(project.pcb, 'The curated example must retain its actual expert PCB.');
const board = project.pcb;
const part = project.schematic.parts.find((item) => item.ref === 'U1');
const footprint = board.footprints.find((item) => item.symbolId === part?.id);
assert.ok(footprint, 'The LM2596 U1 footprint must resolve by stable ID.');
const boardBefore = JSON.stringify(board);
const config = defaultThermalConfig(board);
config.heatSources = [{ footprintId: footprint.id, powerW: 1 }];
const meshes = [2, 1, 0.5, 0.4];
const runs: { meshSizeMm: number; durationSeconds: number; result: ThermalResult }[] = [];
for (const meshSizeMm of meshes) {
  console.log(`Solving LM2596 Buck, U1 prescribed 1 W into board, mesh ${meshSizeMm} mm…`);
  const started = performance.now();
  const runConfig = { ...config, meshSizeMm };
  const model = prepareThermalModel(board, runConfig);
  const result =
    meshSizeMm === meshes.at(-1)
      ? await runThroughService(project, runConfig)
      : validateThermalResult(await runThermalSimulation(model, control.signal));
  assert.equal(result.basis, model.basis);
  assert.ok(
    result.statistics.energyImbalanceRelative < 0.005,
    `Energy balance at ${meshSizeMm} mm exceeds 0.5%.`,
  );
  assert.ok(result.statistics.maxC > config.ambientC, 'A powered board must rise above ambient.');
  runs.push({ meshSizeMm, durationSeconds: (performance.now() - started) / 1000, result });
  console.log(JSON.stringify({ meshSizeMm, ...result.statistics }));
}
const fine = runs.at(-1)!;
const previous = runs.at(-2)!;
const convergenceRelative =
  Math.abs(fine.result.statistics.maxC - previous.result.statistics.maxC) /
  (fine.result.statistics.maxC - config.ambientC);
assert.ok(
  convergenceRelative < 0.05,
  `Maximum temperature-rise change ${convergenceRelative} exceeds 5%; refine the mesh before claiming convergence.`,
);
console.log('Checking the same board with copper conductivity reduced to dielectric conductivity…');
const controlModel = prepareThermalModel(board, {
  ...config,
  meshSizeMm: fine.meshSizeMm,
  copperConductivity: config.dielectricConductivity,
});
const conductivityControl = validateThermalResult(
  await runThermalSimulation(controlModel, control.signal),
);
assert.ok(
  conductivityControl.statistics.maxC > fine.result.statistics.maxC,
  'Removing the copper conductivity advantage must increase the hotspot temperature on this board.',
);
assert.ok(
  conductivityControl.statistics.energyImbalanceRelative < 0.005,
  'Uniform-conductivity control energy balance exceeds 0.5%.',
);
assert.equal(JSON.stringify(board), boardBefore, 'Thermal analysis must not change the board.');
assert.equal(
  createHash('sha256')
    .update(await readFile(catalogFile))
    .digest('hex'),
  catalogHash,
  'Curated example source bytes must remain unchanged.',
);

const report = {
  version: 1,
  example: id,
  projectName: project.name,
  catalogSha256: catalogHash,
  boardSha256: createHash('sha256').update(boardBefore).digest('hex'),
  analysis: 'steady board temperature',
  finestMeshTransport: 'authenticated loopback HTTP using the generated service compiler',
  powerSource:
    'Prescribed 1 W into U1 pad area; not a SPICE loss measurement or a junction temperature.',
  solver,
  config: { ...config, meshSizeMm: fine.meshSizeMm },
  analytical: {
    case: '10 mm square layered slab; uniform front heat flux; front/back convection; insulated edges',
    expectedRiseC: expectedRise,
    observedRiseC: observedRise,
    relativeError: analyticalRelativeError,
    statistics: slabResult.statistics,
  },
  runs: runs.map(({ meshSizeMm, durationSeconds, result }) => ({
    meshSizeMm,
    durationSeconds,
    basis: result.basis,
    statistics: result.statistics,
  })),
  convergenceRelative,
  conductivityControl: {
    copperConductivity: config.dielectricConductivity,
    basis: conductivityControl.basis,
    statistics: conductivityControl.statistics,
    hotspotIncreaseC: conductivityControl.statistics.maxC - fine.result.statistics.maxC,
  },
  assumptions: fine.result.assumptions,
  diagnostics: fine.result.diagnostics,
};
await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + '\n');
await writeFile(`${directory}/result.json`, JSON.stringify(fine.result));
const surface = thermalSurface(fine.result, 'front');
const points = surface.indices.map((index) => fine.result.points[index]);
const xs = points.map((point) => point.x),
  ys = points.map((point) => point.y);
const minX = Math.min(...xs),
  minY = Math.min(...ys),
  width = Math.max(...xs) - minX,
  height = Math.max(...ys) - minY;
const scale = Math.min(800 / width, 520 / height);
const x = (value: number) => 80 + (value - minX) * scale;
const y = (value: number) => 110 + (value - minY) * scale;
const { minC, maxC } = fine.result.statistics;
const polygons = surface.triangles
  .map((triangle) => {
    const nodes = triangle.map((index) => fine.result.points[index]);
    const value = nodes.reduce((sum, node) => sum + node.temperatureC, 0) / 3;
    return `<polygon points="${nodes.map((point) => `${x(point.x)},${y(point.y)}`).join(' ')}" fill="${thermalColor(value, minC, maxC)}"/>`;
  })
  .join('');
const legend = Array.from(
  { length: 160 },
  (_, i) =>
    `<rect x="910" y="${110 + i * 3}" width="24" height="3.1" fill="${thermalColor(maxC - (i / 159) * (maxC - minC), minC, maxC)}"/>`,
).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1060" height="760" viewBox="0 0 1060 760"><rect width="1060" height="760" fill="white"/><g font-family="Segoe UI,Arial,sans-serif" fill="#202020"><text x="40" y="42" font-size="25">OpenPE · LM2596 Buck board temperature</text><text x="40" y="72" font-size="16">Gmsh ${fine.result.solver.gmsh} · Elmer ${fine.result.solver.elmer} · steady state</text>${polygons}${legend}<text x="944" y="123" font-size="16">${maxC.toFixed(2)} °C</text><text x="944" y="590" font-size="16">${minC.toFixed(2)} °C</text><text x="40" y="664" font-size="16">U1: prescribed 1 W into PCB pads · ambient ${config.ambientC} °C · mesh ${fine.meshSizeMm} mm</text><text x="40" y="693" font-size="15">Energy imbalance ${(fine.result.statistics.energyImbalanceRelative * 100).toFixed(4)}% · refinement change ${(convergenceRelative * 100).toFixed(3)}%</text><text x="40" y="725" font-size="14">Board temperature under stated material/cooling assumptions; package junction temperature is outside this model.</text></g></svg>`;
await writeFile(`${directory}/temperature-map.svg`, svg);
await sharp(Buffer.from(svg)).png().toFile(`${directory}/temperature-map.png`);
console.log(
  JSON.stringify({
    report: `${directory}/report.json`,
    image: `${directory}/temperature-map.png`,
    analyticalRelativeError,
    convergenceRelative,
  }),
);
