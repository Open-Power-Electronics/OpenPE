import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { projectFromNativeFiles } from '../lib/project';
import type { Point } from '../lib/circuit';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import {
  defaultThermalConfig,
  deriveThermalSpiceSources,
  prepareThermalModel,
  validateThermalResult,
} from '../lib/thermal';
import { runThermalSimulation } from '../server/thermal-runtime.mjs';
import { extrudeThermalMesh, parseThermalPlanarMesh } from '../server/thermal-mesh.mjs';

// Explicit offline coupled check. First run simulation:check-emc-flyback.
const arguments_ = process.argv.slice(2);
if (arguments_.length && !/^--mesh-size-mm=\d+(?:\.\d+)?$/.test(arguments_[0]))
  throw new Error('Usage: check-emc-flyback-thermal.ts [--mesh-size-mm=3]');
if (arguments_.length > 1) throw new Error('Only one mesh-size argument is supported.');
const meshSizeMm = arguments_.length ? Number(arguments_[0].split('=')[1]) : 2;
assert.ok(meshSizeMm > 0 && meshSizeMm <= 1000, 'Mesh size must be within (0, 1000] mm.');
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const nativePath = path.resolve('recent/emc-flyback/emc-flyback.kicad_pro');
const native = await readNativeProject(nativePath);
const project = projectFromNativeFiles(native);
const deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
const completed = JSON.parse(
  await readFile('test-results/emc-flyback-simulation/result.json', 'utf8'),
);
const imported = deriveThermalSpiceSources(project.schematic, project.pcb!, deck, completed);
const config = {
  ...defaultThermalConfig(project.pcb!),
  heatSources: imported.heatSources,
  meshSizeMm,
};
const model = prepareThermalModel(project.pcb!, config);
const started = Date.now();
const directory = `test-results/emc-flyback-thermal${meshSizeMm === 2 ? '' : `-${meshSizeMm}mm`}`;
await mkdir(directory, { recursive: true });
console.log(
  `Solving EMC Flyback board with ${imported.losses.length} SPICE heat paths (${imported.window.startS}–${imported.window.endS} s).`,
);
const result = validateThermalResult(
  await runThermalSimulation(
    model,
    new AbortController().signal,
    undefined,
    (event: { stage: string; message?: string }) => {
      if (event.message) console.log(`${event.stage}: ${event.message}`);
    },
    async ({ directory: stage }: { directory: string }) => {
      const copy = async (folder: string, destination: string) => {
        await mkdir(destination, { recursive: true });
        for (const file of await readdir(folder, { withFileTypes: true })) {
          if (file.isSymbolicLink()) throw new Error('Unexpected linked solver artifact.');
          const source = `${folder}/${file.name}`,
            target = `${destination}/${file.name}`;
          if (file.isDirectory()) await copy(source, target);
          else if (file.isFile()) await copyFile(source, target);
        }
      };
      await copy(stage, `${directory}/artifacts`);
    },
  ),
);
assert.ok(result.statistics.maxC > config.ambientC);
assert.ok(result.statistics.energyImbalanceRelative < 0.005);
assert.deepEqual(
  await readNativeProject(nativePath),
  native,
  'Thermal analysis preserves native files.',
);
await writeFile(`${directory}/result.json`, JSON.stringify(result));
const mesh = extrudeThermalMesh(
  parseThermalPlanarMesh(await readFile(`${directory}/artifacts/planar.msh`, 'utf8')),
  model,
);
const insideRing = (point: Point, ring: Point[]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
};
// Integrate linear surface triangles over the same conforming source regions as
// the prescribed flux. These are PCB-pad temperatures, never package junctions.
const padTemperatures = model.sources.map((source) => {
  let area = 0,
    integral = 0,
    minC = Infinity,
    maxC = -Infinity;
  for (const face of mesh.boundaries) {
    if (face.side !== (source.side === 'front' ? 'top' : 'bottom')) continue;
    const points = face.ids.map((id: number) => result.points[id - 1]);
    const center = {
      x: points.reduce((n: number, point: Point) => n + point.x, 0) / points.length,
      y: points.reduce((n: number, point: Point) => n + point.y, 0) / points.length,
    };
    if (
      !source.polygons.some(
        (polygon) =>
          insideRing(center, polygon.outer) &&
          !polygon.holes.some((hole) => insideRing(center, hole)),
      )
    )
      continue;
    const temperatures: number[] = points.map(
      (point: { temperatureC: number }) => point.temperatureC,
    );
    area += face.areaM2;
    integral +=
      (face.areaM2 * temperatures.reduce((n, value) => n + value, 0)) / temperatures.length;
    minC = Math.min(minC, ...temperatures);
    maxC = Math.max(maxC, ...temperatures);
  }
  assert.ok(area > 0, `No pad triangles for ${source.footprintId}.`);
  return {
    reference: imported.losses.find((loss) => loss.footprintId === source.footprintId)?.reference,
    footprintId: source.footprintId,
    powerW: source.powerW,
    padMeanC: integral / area,
    padMinC: minC,
    padMaxC: maxC,
    padAreaMm2: area * 1e6,
  };
});
await writeFile(
  `${directory}/pad-temperatures.json`,
  JSON.stringify(padTemperatures, null, 2) + '\n',
);
const summary = {
  solver: result.solver,
  elapsedMs: Date.now() - started,
  config,
  electricalWindow: imported.window,
  losses: imported.losses,
  statistics: result.statistics,
  assumptions: [...imported.assumptions, ...result.assumptions],
};
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
