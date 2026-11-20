// Explicit real-solver integration check. No Electron launch.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createReferenceExample, referenceExamples } from '../lib/reference-examples';
import { homeExampleNativePath } from '../lib/home-examples';
import { buildSpiceDeck, defaultTransient } from '../plugins/spice-simulation/domain/spice';
import { buildSpiceDeck as serviceDeck } from '../plugins/spice-simulation/host/spice-format.mjs';
import {
  serializeProject,
  parseProject,
  projectFromNativeFiles,
  projectNativeFiles,
} from '../lib/project';
import { runSimulation } from '../plugins/spice-simulation/host/spice.mjs';
import { adaptSpiceModels } from '../plugins/spice-simulation/host/spice-model-adapters.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';
import { readProjectModelFile, prepareProjectModelFiles } from '../server/project-model-files.mjs';
import type { SimulationSamples } from '../plugins/spice-simulation/renderer/simulation-stream';
import { homeSimulationDurationFor, verifyHomeOutput } from './home-simulation-verification';

const directory = 'test-results/example-simulations';
const { readNativeProject, writeNativeProject } = createRequire(import.meta.url)(
  '../electron/native-project.cjs',
);
const { atomicWrite } = await import('../server/atomic-write.mjs');
await mkdir(directory, { recursive: true });
const offline = async () => {
  throw new Error('Missing separate model file. Run npm run simulation:download-examples first.');
};
const cases = [
  ...referenceExamples.map((p) => ({
    id: p.id,
    sourcePath: homeExampleNativePath(p.id),
    project: () => createReferenceExample(p.id),
  })),
];
const selected = cases.filter((v) => !process.argv[2] || v.id.includes(process.argv[2]));
assert.ok(selected.length, 'No simulation examples matched the requested filter.');
let failed = 0;
const summary: {
  id: string;
  passed: boolean;
  error?: string;
  samples?: number;
  stop?: number;
  version?: string;
  sourcePath: string;
  durationMs: number;
  previewPackets?: number;
  outputs?: {
    label: string;
    mean: number;
    peakToPeak: number;
    ripplePercent: number;
    driftPercent: number;
  }[];
}[] = [];
for (const entry of selected) {
  const started = performance.now();
  try {
    // Exercise the files users open, including the generated service compiler.
    const nativeFiles = entry.sourcePath.endsWith('.kicad_pro')
      ? await readNativeProject(path.resolve(entry.sourcePath))
      : null;
    const fileSource = nativeFiles
      ? JSON.stringify(nativeFiles)
      : await readFile(entry.sourcePath, 'utf8');
    const project = nativeFiles ? projectFromNativeFiles(nativeFiles) : parseProject(fileSource),
      source = serializeProject(project);
    const d = parseProject(source).schematic,
      config = defaultTransient(d);
    if (entry.id.startsWith('reference-'))
      assert.equal(
        config.stop,
        homeSimulationDurationFor(entry.id),
        'Unexpected Home default duration.',
      );
    const deck = serviceDeck(d, config);
    assert.deepEqual(deck, buildSpiceDeck(d, config), 'Renderer/service decks differ.');
    const bundled = parseProject(serializeProject(entry.project())).schematic;
    const bundledDeck = buildSpiceDeck(bundled, defaultTransient(bundled));
    assert.equal(deck.netlist, bundledDeck.netlist, 'Example file and bundled template differ.');
    await writeFile(`${directory}/${entry.id}.cir`, deck.netlist);
    const modelFiles = {
      read: (_grant: string, model: { id: string; sha256: string; file: string }) =>
        readProjectModelFile(path.resolve(entry.sourcePath), model),
      write: async () => {},
    };
    const projectModels = projectSimulationModels(project, offline, modelFiles, 'isolated-fixture');
    const verifiedModels = new Map();
    for (const modelId of deck.modelIds ?? [])
      verifiedModels.set(modelId, await projectModels.store(modelId, new AbortController().signal));
    const executedDeck = adaptSpiceModels(deck, verifiedModels);
    if (executedDeck !== deck)
      await writeFile(`${directory}/${entry.id}-executed.cir`, executedDeck.netlist);
    let previewPackets = 0,
      previewSamples = 0;
    const result = await runSimulation(
      deck,
      new AbortController().signal,
      projectModels.store,
      undefined,
      (packet: SimulationSamples) => {
        assert.equal(packet.offset, previewSamples);
        assert.equal(packet.values.length, deck.traces.length);
        assert.ok(packet.time.every(Number.isFinite));
        previewPackets++;
        previewSamples += packet.time.length;
      },
    );
    assert.equal(serializeProject(project), source);
    assert.equal(serializeProject(parseProject(source)), source);
    const currentSource = nativeFiles
      ? JSON.stringify(await readNativeProject(path.resolve(entry.sourcePath)))
      : await readFile(entry.sourcePath, 'utf8');
    assert.equal(currentSource, fileSource, 'Example file changed.');
    const traces = result.traces.map((t: { label: string; values: number[] }) => ({
      label: t.label,
      min: Math.min(...t.values),
      max: Math.max(...t.values),
      final: t.values.at(-1)!,
      tailMean:
        t.values.slice(Math.floor(t.values.length * 0.8)).reduce((a, b) => a + b, 0) /
        (t.values.length - Math.floor(t.values.length * 0.8)),
    }));
    assert.ok(
      traces.some((t: { min: number; max: number }) => t.max - t.min > 1e-6),
      'No changing signal.',
    );
    const outputs = [];
    if (entry.id.startsWith('reference-')) {
      const bounds: Record<string, [number, number]> = {
        'reference-lm2596-to220-5-buck': [4.6, 5.2],
        'reference-tps61046-bga6-boost': [18, 20],
        'reference-lm2735-msop8-sepic': [4.75, 5.25],
        'reference-lm2598-to220-7-buck': [9.5, 10.5],
        'reference-lm25017-wson8-flybuck': [6.4, 7.1],
        'reference-lm5001-soic8-boost': [46.5, 49.5],
        'reference-lm27761-wson8-pump': [-3.45, -3.15],
        'reference-lmr12010-sot236-buck': [4.8, 5.3],
        'reference-lmr70503-bga8-buckboost': [-4.15, -3.7],
      };
      const rails = result.traces.filter((trace) => /^V\(VOUT\d*\)$/.test(trace.label));
      assert.equal(
        rails.length,
        entry.id.includes('flybuck') ? 2 : 1,
        'Missing Home output voltage trace.',
      );
      for (const rail of rails) {
        const range: [number, number] =
          entry.id.includes('flybuck') && rail.label === 'V(VOUT2)' ? [6.1, 6.8] : bounds[entry.id];
        const metrics = verifyHomeOutput(result.time, rail.values, range, config.stop);
        outputs.push({ label: rail.label, ...metrics });
      }
    }
    const reopened = parseProject(
      serializeProject({
        ...project,
        ...(projectModels.models.length ? { simulationModels: projectModels.models } : {}),
      }),
    );
    assert.deepEqual(reopened.pcb, project.pcb);
    const copiedFile = path.resolve(directory, 'projects', entry.id, 'project.kicad_pro');
    await mkdir(path.dirname(copiedFile), { recursive: true });
    await prepareProjectModelFiles(
      reopened,
      copiedFile,
      path.resolve(entry.sourcePath),
      offline,
      new AbortController().signal,
    );
    await writeNativeProject(
      copiedFile,
      projectNativeFiles(reopened, 'project.kicad_pro'),
      atomicWrite,
    );
    const copied = projectFromNativeFiles(await readNativeProject(copiedFile));
    const projectOffline = projectSimulationModels(
      copied,
      offline,
      {
        read: (_grant: string, model: { id: string; sha256: string; file: string }) =>
          readProjectModelFile(copiedFile, model),
        write: async () => {},
      },
      'isolated-fixture',
    );
    for (const modelId of [...(deck.modelIds || []), ...(deck.modelId ? [deck.modelId] : [])]) {
      assert.deepEqual(
        await projectOffline.store(modelId, new AbortController().signal),
        await projectModels.store(modelId, new AbortController().signal),
      );
    }
    await writeFile(
      `${directory}/${entry.id}.json`,
      JSON.stringify(
        {
          sourcePath: entry.sourcePath,
          sourceSha256: createHash('sha256').update(fileSource).digest('hex'),
          deckSha256: createHash('sha256').update(deck.netlist).digest('hex'),
          executedDeckSha256: createHash('sha256').update(executedDeck.netlist).digest('hex'),
          compatibility: executedDeck.compatibility,
          modelReferences: project.simulationModels ?? [],
          durationMs: Math.round(performance.now() - started),
          version: result.version,
          stop: result.time.at(-1),
          samples: result.time.length,
          traces,
          ...(outputs.length ? { outputs } : {}),
          log: result.log,
        },
        null,
        2,
      ),
    );
    console.log(
      `PASS ${entry.id}: ${result.time.length} samples to ${result.time.at(-1)} s, ${previewPackets} live packets, ${result.version}`,
    );
    await unlink(`${directory}/${entry.id}-error.txt`).catch(() => {});
    summary.push({
      previewPackets,
      ...(outputs.length ? { outputs } : {}),
      id: entry.id,
      passed: true,
      samples: result.time.length,
      stop: result.time.at(-1),
      version: result.version,
      sourcePath: entry.sourcePath,
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    failed++;
    await writeFile(`${directory}/${entry.id}-error.txt`, String(error));
    await unlink(`${directory}/${entry.id}.json`).catch(() => {});
    console.error(`FAIL ${entry.id}: ${String(error).slice(0, 700)}`);
    summary.push({
      id: entry.id,
      passed: false,
      error: String(error),
      sourcePath: entry.sourcePath,
      durationMs: Math.round(performance.now() - started),
    });
  }
}
await writeFile(
  `${directory}/summary${process.argv[2] ? '-filtered' : ''}.json`,
  JSON.stringify(summary, null, 2),
);
if (failed) process.exitCode = 1;
