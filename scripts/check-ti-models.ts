// Opt-in integration check: real project-bundled ngspice, no desktop launch.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTiExample } from '../lib/ti-examples';
import { tiModels } from '../lib/ti-dcdc';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { serializeProject, parseProject } from '../lib/project';
import { runSimulation } from '../server/spice.mjs';
import { createTiModelStore } from '../server/ti-models.mjs';

const directory = 'test-results/ti-validation';
await mkdir(directory, { recursive: true });
const store = createTiModelStore(directory);
for (const model of tiModels) {
  const project = createTiExample(`Regulator_Switching:LM2596S-${model.voltage}`);
  const source = serializeProject(project);
  const d = parseProject(source).schematic;
  const deck = buildSpiceDeck(d, defaultTransient(d));
  const result = await runSimulation(deck, new AbortController().signal, store);
  const offline = createTiModelStore(directory, async () => { throw new Error('Unexpected network access for a cached model.'); });
  assert.deepEqual(await offline(model.id, new AbortController().signal), await store(model.id, new AbortController().signal));
  const tail = result.traces[0].values.slice(
    result.time.findIndex((t: number) => t >= deck.stop - 0.0005),
  );
  const average = tail.reduce((a: number, b: number) => a + b, 0) / tail.length;
  assert.ok(Math.abs(average / model.voltage - 1) < 0.08, `${model.id}: ${average} V`);
  await writeFile(
    `${directory}/${model.id}.json`,
    JSON.stringify(
      { version: result.version, average, samples: result.time.length, log: result.log },
      null,
      2,
    ),
  );
  console.log(
    `${model.id}: ${average.toFixed(4)} V, ${result.time.length} finite samples, ${result.version}`,
  );
}
