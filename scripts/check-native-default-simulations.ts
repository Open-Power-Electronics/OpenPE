// Opt-in real-solver release check. Uses ordinary native import and unchanged defaults.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectFromNativeFiles } from '../lib/project';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import {
  defaultThermalConfig,
  deriveThermalSpiceSources,
  prepareThermalModel,
  validateThermalResult,
} from '../lib/thermal';
import { runSimulation } from '../server/spice.mjs';
import { runThermalSimulation } from '../server/thermal-runtime.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';
import { readProjectModelFile } from '../server/project-model-files.mjs';
import { verifyHomeOutput } from './home-simulation-verification';

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const catalog = JSON.parse(await readFile('resources/example-catalog/home-manifest.json', 'utf8'));
const filters = process.argv[2]?.split(',');
const entries = [...catalog.examples, ...catalog.recent].filter(
  (entry) => !filters || filters.some((filter) => entry.file.includes(filter)),
);
assert.ok(entries.length, 'No bundled native projects matched.');
const bounds: Record<string, [number, number]> = {
  'lm2596-to220-5-buck': [4.6, 5.2],
  'tps61046-bga6-boost': [18, 20],
  'lm2735-msop8-sepic': [4.75, 5.25],
  'lm2598-to220-7-buck': [9.5, 10.5],
  'lm25017-wson8-flybuck': [6.4, 7.1],
  'lm5001-soic8-boost': [46.5, 49.5],
  'lm27761-wson8-pump': [-3.45, -3.15],
  'lmr12010-sot236-buck': [4.8, 5.3],
  'lmr70503-bga8-buckboost': [-4.15, -3.7],
};
const limitMs = 600000;
async function timed<T>(name: string, work: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController(),
    started = performance.now();
  const deadline = setTimeout(
    () => controller.abort(new Error(`${name} exceeded 10 minutes.`)),
    limitMs,
  );
  const progress = setInterval(
    () => console.log(`${name}: ${Math.round((performance.now() - started) / 1000)} s`),
    30000,
  );
  try {
    const value = await work(controller.signal);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < limitMs, `${name} exceeded 10 minutes.`);
    return { value, elapsedMs };
  } catch (error) {
    const elapsedMs = performance.now() - started;
    throw Object.assign(
      new Error(
        controller.signal.aborted
          ? `${name} exceeded the 600-second acceptance limit (${Math.round(elapsedMs)} ms).`
          : String(error),
      ),
      { elapsedMs },
    );
  } finally {
    clearTimeout(deadline);
    clearInterval(progress);
  }
}
let failures = 0;
for (const entry of entries) {
  const directory = path.resolve('test-results/native-default-simulations', entry.file);
  await mkdir(directory, { recursive: true });
  const report: Record<string, unknown> = {
    project: entry.file,
    checkedAt: new Date().toISOString(),
    limitMs,
    passed: false,
  };
  let stage = 'import';
  try {
    const filename = path.resolve(entry.root, entry.directory, `${entry.file}.kicad_pro`);
    const native = await readNativeProject(filename),
      project = projectFromNativeFiles(native);
    report.nativeSha256 = createHash('sha256').update(JSON.stringify(native)).digest('hex');
    const config = defaultTransient(project.schematic),
      deck = buildSpiceDeck(project.schematic, config);
    report.spiceConfig = config;
    report.deckSha256 = createHash('sha256').update(deck.netlist).digest('hex');
    const models = projectSimulationModels(
      project,
      async () => {
        throw new Error('Missing offline model.');
      },
      {
        read: (_grant: string, model: { id: string; sha256: string; file: string }) =>
          readProjectModelFile(filename, model),
        write: async () => {},
      },
      'release-check',
    );
    stage = 'spice';
    const spice = await timed(`${entry.file} SPICE`, (signal) =>
      runSimulation(deck, signal, models.store),
    );
    report.spiceMs = spice.elapsedMs;
    await writeFile(path.join(directory, 'spice-result.json'), JSON.stringify(spice.value));
    assert.ok(
      Math.abs(spice.value.time.at(-1)! - config.stop) < 1e-12,
      'The full default transient must finish.',
    );
    stage = 'electrical-output';
    if (bounds[entry.file]) {
      const outputs = spice.value.traces.filter((trace) => /^V\(VOUT\d*\)$/.test(trace.label));
      assert.equal(outputs.length, entry.file.includes('flybuck') ? 2 : 1);
      report.outputs = outputs.map((trace) => ({
        label: trace.label,
        ...verifyHomeOutput(
          spice.value.time,
          trace.values,
          trace.label === 'V(VOUT2)' ? [6.1, 6.8] : bounds[entry.file],
          config.stop,
        ),
      }));
    }
    stage = 'thermal-input';
    assert.ok(project.pcb, 'A PCB is required for the coupled default check.');
    const imported = deriveThermalSpiceSources(project.schematic, project.pcb, deck, spice.value);
    const thermalConfig = {
      ...defaultThermalConfig(project.pcb),
      heatSources: imported.heatSources,
    };
    report.thermalConfig = thermalConfig;
    report.losses = imported.losses;
    stage = 'thermal';
    const thermal = await timed(`${entry.file} Thermal`, async (signal) => {
      const model = prepareThermalModel(project.pcb!, thermalConfig);
      return validateThermalResult(await runThermalSimulation(model, signal));
    });
    report.thermalMs = thermal.elapsedMs;
    report.thermalStatistics = thermal.value.statistics;
    await writeFile(path.join(directory, 'thermal-result.json'), JSON.stringify(thermal.value));
    assert.ok(thermal.value.statistics.energyImbalanceRelative < 0.005);
    assert.ok(thermal.value.statistics.maxC > thermalConfig.ambientC);
    assert.deepEqual(
      await readNativeProject(filename),
      native,
      'Analysis must preserve native files.',
    );
    report.passed = true;
  } catch (error) {
    failures++;
    report.failedStage = stage;
    report.error = String(error);
    if (
      error &&
      typeof error === 'object' &&
      'elapsedMs' in error &&
      ['spice', 'thermal'].includes(stage)
    )
      report[`${stage}Ms`] = error.elapsedMs;
  }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (failures) process.exitCode = 1;
