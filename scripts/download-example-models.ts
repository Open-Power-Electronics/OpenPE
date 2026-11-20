// Prepare portable model files beside native designs; private snapshots retain references.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { referenceExamples } from '../lib/reference-examples';
import { homeExampleNativePath } from '../lib/home-examples';
import { parseProject, serializeProject } from '../lib/project';
import { buildSpiceDeck, defaultTransient } from '../plugins/spice-simulation/domain/spice';
import { simulationModelDefinitions } from '../lib/simulation-models';
import { createSimulationModelStore } from '../server/example-models.mjs';
import {
  prepareProjectModelFiles,
  verifyProjectModelBytes,
} from '../server/project-model-files.mjs';
import { writeGeneratedFile } from './write-generated-file.mjs';
import { verifyEmcFlybackModels } from './prepare-emc-flyback-models';

// Resource preparation is a build operation, separate from live desktop data.
const dataDir = path.resolve('.openpe/example-model-preparation');
const download = createSimulationModelStore(dataDir);
const store = async (id: string, signal: AbortSignal) => {
  const model = simulationModelDefinitions.find((entry) => entry.id === id);
  if (!model) throw new Error('Unsupported simulation model identity.');
  // Shared build resources use pinned identity/hash names, independently of project paths.
  const directory = path.resolve('resources/example-catalog/simulation/models');
  const file = path.join(directory, `${id}-${model.sha256}.lib`);
  const existing = await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  signal.throwIfAborted();
  if (existing) return verifyProjectModelBytes(model, existing);
  const verified = verifyProjectModelBytes(model, await download(id, signal));
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, verified, { flag: 'wx' });
    signal.throwIfAborted();
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return verified;
};

if (process.argv.length > 2) throw new Error('Usage: node --import tsx scripts/download-example-models.ts');
const files = referenceExamples.map((entry) => `tests/fixtures/reference/${entry.file}.json`);
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
  const signal = new AbortController().signal;
  for (const id of ids) await store(id, signal);
  await prepareProjectModelFiles(project, nativeFile, nativeFile, store, signal);
  await writeGeneratedFile(file, serializeProject(project));
  console.log(`${file}: ${ids.size} verified separate model files.`);
}
await verifyEmcFlybackModels();
