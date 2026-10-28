// Prepare portable model files beside native designs; private snapshots retain references.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { referenceExamples } from '../lib/reference-examples';
import { homeExampleNativePath } from '../lib/home-examples';
import { projectExamples } from '../lib/examples';
import { tiDcdcParts } from '../lib/ti-dcdc';
import { parseProject, serializeProject } from '../lib/project';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { simulationModelDefinitions } from '../lib/simulation-models';
import { createSimulationModelStore } from '../server/example-models.mjs';
import {
  prepareProjectModelFiles,
  verifyProjectModelBytes,
} from '../server/project-model-files.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';

// Resource preparation is a build operation, separate from live desktop data.
const dataDir = path.resolve('.openpe/example-model-preparation');
const download = createSimulationModelStore(dataDir);
const store = async (id: string, signal: AbortSignal) => {
  const model = simulationModelDefinitions.find((entry) => entry.id === id);
  if (!model) throw new Error('Unsupported simulation model identity.');
  // Shared build resources use pinned identity/hash names, independently of project paths.
  const bytes = await readFile(
    path.resolve('resources/example-catalog/simulation/models', `${id}-${model.sha256}.lib`),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  signal.throwIfAborted();
  return bytes ? verifyProjectModelBytes(model, bytes) : download(id, signal);
};

const files = [
  ...referenceExamples.map((entry) => `tests/fixtures/reference/${entry.file}.json`),
  ...(process.argv.includes('--fixtures')
    ? [
        ...projectExamples.map((entry) => `tests/fixtures/kicad/${entry.id}.openpe.json`),
        ...tiDcdcParts.map((entry) => `tests/fixtures/ti/${entry.name}.openpe.json`),
      ]
    : []),
];
for (const file of files) {
  const project = parseProject(await readFile(file, 'utf8'));
  const homeEntry = referenceExamples.find(
    (entry) => file === `tests/fixtures/reference/${entry.file}.json`,
  );
  const deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
  const ids = new Set([...(deck.modelIds ?? []), ...(deck.modelId ? [deck.modelId] : [])]);
  if (ids.size)
    project.simulationModels = simulationModelDefinitions
      .filter((model) => ids.has(model.id))
      .map((model) => ({ ...model }));
  const nativeFile = path.resolve(homeEntry ? homeExampleNativePath(homeEntry.id) : file);
  await prepareProjectModelFiles(
    project,
    nativeFile,
    nativeFile,
    store,
    new AbortController().signal,
  );
  await atomicWrite(file, serializeProject(project));
  console.log(`${file}: ${ids.size} verified separate model files.`);
}
