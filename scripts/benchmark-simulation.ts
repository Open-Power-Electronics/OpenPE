// Offline real-solver timing; never launches Electron or contacts a model provider.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { referenceExamples } from '../lib/reference-examples';
import { homeExampleNativePath } from '../lib/home-examples';
import { projectFromNativeFiles } from '../lib/project';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';
import { runSimulation } from '../server/spice.mjs';
import { readProjectModelFile } from '../server/project-model-files.mjs';
import { projectSimulationModels } from '../server/project-models.mjs';

const cases = referenceExamples.filter(
  (entry) => !process.argv[2] || entry.id.includes(process.argv[2]),
);
assert.ok(cases.length, 'No Home simulation matched the requested filter.');
const timings = [];
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
for (const entry of cases) {
  const file = path.resolve(homeExampleNativePath(entry.id));
  const started = performance.now();
  const project = projectFromNativeFiles(await readNativeProject(file));
  const config = defaultTransient(project.schematic);
  const deck = buildSpiceDeck(project.schematic, config);
  assert.deepEqual(deck, serviceDeck(project.schematic, config));
  const prepareMs = performance.now() - started;
  const models = () =>
    projectSimulationModels(
      project,
      async () => {
        throw new Error('Missing offline model. Run npm run simulation:download-examples first.');
      },
      {
        read: (_grant: string, model: Parameters<typeof readProjectModelFile>[1]) =>
          readProjectModelFile(file, model),
        write: async () => {},
      },
      'isolated-benchmark',
    );
  let first;
  for (const run of ['first', 'repeat']) {
    const start = performance.now();
    const result = await runSimulation(deck, new AbortController().signal, models().store);
    const runMs = performance.now() - start;
    if (first)
      assert.deepEqual(result, first, 'Reused results must preserve all samples and targets.');
    else first = result;
    const timing = {
      id: entry.id,
      run,
      prepareMs: Math.round(prepareMs),
      runMs: Math.round(runMs),
      samples: result.time.length,
      version: result.version,
    };
    timings.push(timing);
    console.log(JSON.stringify(timing));
  }
  // A cached run must still reject an unavailable or invalid referenced model.
  if (deck.modelIds?.length || deck.modelId) {
    await assert.rejects(
      runSimulation(deck, new AbortController().signal, async () => {
        throw new Error('Invalid referenced model');
      }),
      /Invalid referenced model/,
    );
    const invalid = projectSimulationModels(
      project,
      undefined,
      {
        read: async () => Buffer.from('changed model bytes'),
        write: async () => {},
      },
      'isolated-benchmark',
    );
    await assert.rejects(
      runSimulation(deck, new AbortController().signal, invalid.store),
      /integrity check/,
    );
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(runSimulation(deck, cancelled.signal), /cancelled|abort/i);
}
await mkdir('test-results/simulation-performance', { recursive: true });
await writeFile(
  `test-results/simulation-performance/benchmark${process.argv[2] ? '-filtered' : ''}.json`,
  JSON.stringify(timings, null, 2) + '\n',
);
