// Opt-in maintenance: publish real native-example analyses, then verify load-only HTTP restoration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homeExamples, homeExampleNativePath, homeRecent } from '../lib/home-examples';
import { projectFromNativeFiles, serializeProject } from '../lib/project';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { defaultThermalConfig, prepareThermalModel } from '../lib/thermal';
import { runSimulation, findSimulationResult } from '../server/spice.mjs';
import { runThermalSimulation } from '../server/thermal-runtime.mjs';
import { createProjectSpiceStore } from '../server/project-spice-files.mjs';
import { createProjectThermalStore } from '../server/project-thermal-files.mjs';
import { readProjectModelFile } from '../server/project-model-files.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';
import { startServer } from '../server/index.mjs';

const launchServer = startServer as unknown as (
  options: Record<string, unknown>,
) => ReturnType<typeof startServer>;
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const filters = process.argv
  .slice(2)
  .find((arg) => !arg.startsWith('--'))
  ?.split(',');
const loadOnly = process.argv.includes('--load-only');
const entries = [...homeExamples, ...homeRecent].filter(
  (entry) => !filters || filters.some((filter) => entry.file.includes(filter)),
);
assert.ok(entries.length);
const signal = new AbortController().signal;
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
let failures = 0;
for (const entry of entries) {
  const folder = path.resolve('test-results/example-result-persistence', entry.file);
  await mkdir(folder, { recursive: true });
  const report: Record<string, unknown> = {
    project: entry.file,
    checkedAt: new Date().toISOString(),
    passed: false,
    mode: loadOnly ? 'load-only' : 'publish-and-load',
  };
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const started = performance.now();
  const progress = setInterval(
    () => console.log(`${entry.file}: ${Math.round((performance.now() - started) / 1000)} s`),
    30000,
  );
  try {
    const filename = path.resolve(homeExampleNativePath(entry.id));
    const native = await readNativeProject(filename);
    const project = projectFromNativeFiles(native);
    const source = serializeProject(project);
    const config = defaultTransient(project.schematic);
    const deck = buildSpiceDeck(project.schematic, config);
    report.nativeSha256 = digest(JSON.stringify(native));
    report.deckSha256 = digest(deck.netlist);
    const modelFiles = {
      read: (_grant: string, model: { id: string; sha256: string; file: string }) =>
        readProjectModelFile(filename, model),
      write: async () => {},
    };
    const offline = async () => {
      throw new Error('Persistence verification must not download models.');
    };
    const modelStore = projectSimulationModels(
      project,
      offline,
      modelFiles,
      '00000000-0000-4000-8000-000000000001',
    ).store;
    const spiceFiles = () => createProjectSpiceStore(() => filename);
    const thermalFiles = () => createProjectThermalStore(() => filename);
    const serverOptions = {
      dataDir: path.join(folder, 'isolated-host'),
      simulationModelFiles: modelFiles,
      simulationModelFetcher: offline,
      simulationResultFiles: {
        forProject: (id: string) =>
          id === '00000000-0000-4000-8000-000000000001' ? spiceFiles() : null,
      },
      thermalResultFiles: {
        forProject: (id: string) =>
          id === '00000000-0000-4000-8000-000000000001' ? thermalFiles() : null,
      },
      simulationRunner: async () => {
        throw new Error('Load-only verification attempted a SPICE solve.');
      },
      thermalRunner: async () => {
        throw new Error('Load-only verification attempted a thermal solve.');
      },
    };
    async function post(route: string, body: object) {
      const response = await fetch(server!.base + '/api/' + route, {
        method: 'POST',
        headers: { 'X-OpenPE-Token': server!.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, fileId: '00000000-0000-4000-8000-000000000001', ...body }),
      });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    }
    const spiceStarted = performance.now();
    const spice = await (loadOnly
      ? findSimulationResult(deck, signal, modelStore, undefined, spiceFiles())
      : runSimulation(deck, signal, modelStore, undefined, undefined, spiceFiles(), config));
    assert.ok(spice, 'A matching saved SPICE result is required.');
    report.spiceMs = performance.now() - spiceStarted;
    assert.ok(Math.abs(spice.time.at(-1)! - config.stop) < 1e-12);
    server = await launchServer(serverOptions);
    const imported = await post('thermal/spice-sources', {});
    const thermalConfig = {
      ...defaultThermalConfig(project.pcb!),
      heatSources: imported.heatSources,
      spiceSource: imported.spiceSource,
    };
    const prepared = prepareThermalModel(project.pcb!, thermalConfig);
    const savedThermal = await thermalFiles().read(signal);
    let thermal;
    const thermalStarted = performance.now();
    if (savedThermal && JSON.stringify(savedThermal.model) === JSON.stringify(prepared)) {
      const restored = await post('thermal/result', { config: thermalConfig });
      thermal = restored.result;
    }
    if (!thermal && loadOnly) throw new Error('A matching saved thermal result is required.');
    if (!thermal)
      thermal = await runThermalSimulation(
        prepared,
        signal,
        undefined,
        undefined,
        async ({
          directory,
          result,
          solver,
        }: {
          directory: string;
          result: unknown;
          solver: unknown;
        }) => {
          await thermalFiles().write(directory, prepared, result, solver, signal);
        },
      );
    report.thermalMs = performance.now() - thermalStarted;
    server.close();
    server = await launchServer(serverOptions);
    const loadedSpice = await post('simulation/result', {});
    assert.deepEqual(loadedSpice.config, config);
    assert.deepEqual(loadedSpice.result, spice);
    const loadedThermal = await post('thermal/result', {});
    assert.deepEqual(loadedThermal.config, thermalConfig);
    assert.deepEqual(loadedThermal.result, thermal);
    assert.deepEqual(await readNativeProject(filename), native);
    report.spiceLoadedWithoutSolving = true;
    report.thermalLoadedWithoutSolving = true;
    report.spiceManifest = path.join(
      path.dirname(filename),
      'spice',
      entry.file + '.manifest.json',
    );
    report.thermalManifest = path.join(
      path.dirname(filename),
      'thermal',
      entry.file + '.manifest.json',
    );
    report.spiceConfig = config;
    report.thermalStatistics = thermal.statistics;
    report.passed = true;
  } catch (error) {
    failures++;
    report.error = String(error);
  } finally {
    server?.close();
    clearInterval(progress);
  }
  await writeFile(
    path.join(folder, loadOnly ? 'load-report.json' : 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
if (failures) process.exitCode = 1;
